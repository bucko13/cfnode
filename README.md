# CFNode - Compact Filters Node
A simple utility wrapper around [bcoin](https://bcoin.io) to allow for an easy spin up
of a _light_ node for serving compact filters. This is similar to an SPV node
in that it is stripped of most elements of a full node, except that it runs a blockchain
index and a filter index. Running a pruned node, the database shouldn't be around > 10GB
for mainnet as of March, 2019 (around 4.69GB for the chain and 4.14GB for the filters) and
syncing shouldn't take more than a few days.

More info on compact, golomb coded set filters in Bitcoin can be found at the relevant
BIPs [157](https://github.com/bitcoin/bips/blob/master/bip-0157.mediawiki) and
[158](https://github.com/bitcoin/bips/blob/master/bip-0158.mediawiki).

## Usage
### From Command Line
To run from command line, install with git:
```bash
$ git clone https://github.com/bucko13/cfnode
$ cd cfnode
$ yarn install
$ ./bin/cfnode --pruned --checkpoints
```

Note that you can't retroactively turn on pruned or checkpoints
for an existing chain database. If you find yourself in that position
you can set a different prefix `--prefix=[absolute path to location]`
or delete your existing chain db. Alternatively, just run `./bin/cfnode`
to use existing db setup. DBs are saved in bcoin's default location: `~/.bcoin`.

### As Library
```bash
$ yarn add cfnode
```

```javascript
'use strict';

const {CFNode} = require('cfnode');

const node = new CFNode({
  memory: true,
  network: 'testnet',
  workers: true
});

(async () => {
  await node.open();
  await node.connect();

  node.on('connect', (entry, block) => {
    console.log('%s (%d) added to chain.', entry.rhash(), entry.height);
  });

  node.on('tx', (tx) => {
    console.log('%s added to mempool.', tx.txid());
  });

  node.startSync();
})().catch((err) => {
  console.error(err.stack);
  process.exit(1);
});
```

## Contribution and License Agreement
If you contribute code to this project, you are implicitly allowing your code to be distributed under the MIT license.
You are also implicitly verifying that all code is your original work. </legalese>

## License
All code in this library is based on or directrly from existing code from [bcoin](https://github.com/bcoin-org/bcoin)