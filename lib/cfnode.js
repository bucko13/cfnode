/*!
 * FilterNode.js - filter node for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');
const {Lock} = require('bmutex');
const Chain = require('bcoin/lib/blockchain/chain');
const Pool = require('bcoin/lib/net/pool');
const {Node, HTTP, RPC} = require('bcoin/lib/node');
const FilterIndexer = require('bcoin/lib/indexer/filterindexer');

/**
 * Filter Node
 * Create a filter node which only maintains
 * a chain, a pool, a filter index and an http server.
 * @alias module:node.FilterNode
 * @extends Node
 */

class FilterNode extends Node {
  /**
   * Create Filter node.
   * @constructor
   * @param {Object?} options
   * @param {Buffer?} options.sslKey
   * @param {Buffer?} options.sslCert
   * @param {Number?} options.httpPort
   * @param {String?} options.httpHost
   */

  constructor(options) {
    super('bcoin', 'bcoin.conf', 'debug.log', options);

    this.opened = false;

    // Instantiate blockchain.
    this.chain = new Chain({
      network: this.network,
      logger: this.logger,
      workers: this.workers,
      memory: this.config.bool('memory'),
      prefix: this.config.prefix,
      maxFiles: this.config.uint('max-files'),
      cacheSize: this.config.mb('cache-size'),
      forceFlags: this.config.bool('force-flags'),
      bip91: this.config.bool('bip91'),
      bip148: this.config.bool('bip148'),
      prune: this.config.bool('prune'),
      checkpoints: this.config.bool('checkpoints'),
      coinCache: this.config.mb('coin-cache'),
      entryCache: this.config.uint('entry-cache')
    });

    this.filterindex= new FilterIndexer({
      network: this.network,
      logger: this.logger,
      chain: this.chain,
      memory: this.config.bool('memory'),
      prefix: this.config.filter('index').str('prefix') || this.config.prefix
    });

    this.pool = new Pool({
      network: this.network,
      logger: this.logger,
      chain: this.chain,
      prefix: this.config.prefix,
      proxy: this.config.str('proxy'),
      onion: this.config.bool('onion'),
      upnp: this.config.bool('upnp'),
      seeds: this.config.array('seeds'),
      nodes: this.config.array('nodes'),
      only: this.config.array('only'),
      maxOutbound: this.config.uint('max-outbound'),
      createSocket: this.config.func('create-socket'),
      memory: this.config.bool('memory'),
      filterindex: this.filterindex,
      selfish: true,
      listen: false
    });

    this.rpc = new RPC(this);

    this.http = new HTTP({
      network: this.network,
      logger: this.logger,
      node: this,
      prefix: this.config.prefix,
      ssl: this.config.bool('ssl'),
      keyFile: this.config.path('ssl-key'),
      certFile: this.config.path('ssl-cert'),
      host: this.config.str('http-host'),
      port: this.config.uint('http-port'),
      apiKey: this.config.str('api-key'),
      noAuth: this.config.bool('no-auth'),
      cors: this.config.bool('cors')
    });

    this.rescanJob = null;
    this.scanLock = new Lock();
    this.watchLock = new Lock();

    this.init();
  }

  /**
   * Initialize the node.
   * @private
   */

  init() {
    // Bind to errors
    this.chain.on('error', err => this.error(err));
    this.pool.on('error', err => this.error(err));

    if (this.http)
      this.http.on('error', err => this.error(err));

    this.pool.on('tx', (tx) => {
      if (this.rescanJob)
        return;

      this.emit('tx', tx);
    });

    this.chain.on('block', (block) => {
      this.emit('block', block);
    });

    this.chain.on('connect', async (entry, block) => {
      if (this.rescanJob) {
        try {
          await this.watchBlock(entry, block);
        } catch (e) {
          this.error(e);
        }
        return;
      }

      this.emit('connect', entry, block);
    });

    this.chain.on('disconnect', (entry, block) => {
      this.emit('disconnect', entry, block);
    });

    this.chain.on('reorganize', (tip, competitor) => {
      this.emit('reorganize', tip, competitor);
    });

    this.chain.on('reset', (tip) => {
      this.emit('reset', tip);
    });

    this.loadPlugins();
  }

  /**
   * Open the node and all its child objects,
   * wait for the database to load.
   * @returns {Promise}
   */

  async open() {
    assert(!this.opened, 'FilterNode is already open.');
    this.opened = true;

    await this.handlePreopen();
    await this.chain.open();
    await this.pool.open();


    if (this.filterindex)
      await this.filterindex.open();

    await this.openPlugins();

    await this.http.open();
    await this.handleOpen();


    this.logger.info('Node is loaded.');
  }

  /**
   * Close the node, wait for the database to close.
   * @returns {Promise}
   */

  async close() {
    assert(this.opened, 'FilterNode is not open.');
    this.opened = false;

    if (this.filterindex)
      await this.filterindex.close();

    await this.handlePreclose();
    await this.http.close();

    await this.closePlugins();

    await this.pool.close();
    await this.chain.close();
    await this.handleClose();
  }

  /**
   * Scan for any missed transactions.
   * Note that this will replay the blockchain sync.
   * @param {Number|Hash} start - Start block.
   * @param {Bloom} filter
   * @param {Function} iter - Iterator.
   * @returns {Promise}
   */

  async scan(start, filter, iter) {
    const unlock = await this.scanLock.lock();
    const height = this.chain.height;

    try {
      await this.chain.replay(start);

      if (this.chain.height < height) {
        // We need to somehow defer this.
        // await this.connect();
        // this.startSync();
        // await this.watchUntil(height, iter);
      }
    } finally {
      unlock();
    }
  }

  /**
   * Watch the blockchain until a certain height.
   * @param {Number} height
   * @param {Function} iter
   * @returns {Promise}
   */

  watchUntil(height, iter) {
    return new Promise((resolve, reject) => {
      this.rescanJob = new RescanJob(resolve, reject, height, iter);
    });
  }

  /**
   * Handled watched block.
   * @param {ChainEntry} entry
   * @param {MerkleBlock} block
   * @returns {Promise}
   */

  async watchBlock(entry, block) {
    const unlock = await this.watchLock.lock();
    try {
      if (entry.height < this.rescanJob.height) {
        await this.rescanJob.iter(entry, block.txs);
        return;
      }
      this.rescanJob.resolve();
      this.rescanJob = null;
    } catch (e) {
      this.rescanJob.reject(e);
      this.rescanJob = null;
    } finally {
      unlock();
    }
  }

  /**
   * Broadcast a transaction (note that this will _not_ be verified
   * by the mempool - use with care, lest you get banned from
   * bitcoind nodes).
   * @param {TX|Block} item
   * @returns {Promise}
   */

  async broadcast(item) {
    try {
      await this.pool.broadcast(item);
    } catch (e) {
      this.emit('error', e);
    }
  }

  /**
   * Broadcast a transaction (note that this will _not_ be verified
   * by the mempool - use with care, lest you get banned from
   * bitcoind nodes).
   * @param {TX} tx
   * @returns {Promise}
   */

  sendTX(tx) {
    return this.broadcast(tx);
  }

  /**
   * Broadcast a transaction. Silence errors.
   * @param {TX} tx
   * @returns {Promise}
   */

  relay(tx) {
    return this.broadcast(tx);
  }

  /**
   * Connect to the network.
   * @returns {Promise}
   */

  connect() {
    return this.pool.connect();
  }

  /**
   * Disconnect from the network.
   * @returns {Promise}
   */

  disconnect() {
    return this.pool.disconnect();
  }

  /**
   * Start the blockchain sync.
   */

  startSync() {
    return this.pool.startSync();
  }

  /**
   * Stop syncing the blockchain.
   */

  stopSync() {
    return this.pool.stopSync();
  }

  /**
   * Retrieve compact filter by hash and type..
   * @param {Hash} hash
   * @param {Number} type
   * @returns {Promise} - Returns {@link Buffer}.
   */

  async getCFilter(hash, type) {
    return this.filterindex.getCFilter(hash, type);
  }

  /**
   * Retrieve compact filter header by hash and type..
   * @param {Hash} hash
   * @param {Number} type
   * @returns {Promise} - Returns {@link Hash}.
   */

  async getCFHeader(hash, type) {
    return this.filterindex.getCFHeader(hash, type);
  }
}

/*
 * Helpers
 */

class RescanJob {
  constructor(resolve, reject, height, iter) {
    this.resolve = resolve;
    this.reject = reject;
    this.height = height;
    this.iter = iter;
  }
}

/*
 * Expose
 */

module.exports = FilterNode;
