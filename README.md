# DAO Voting

## Install

```sh
npm ci
```

## Start Node · Terminal 1

```sh
npm run node
```

## Deploy and Serve · Terminal 2

```sh
VOTING_DURATION_SECONDS=180 npm run deploy:local
npm run web
```

## Close Voting · Terminal 3

```sh
curl -fsS http://127.0.0.1:8545 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"evm_increaseTime","params":[181],"id":1}'
curl -fsS http://127.0.0.1:8545 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"evm_mine","params":[],"id":2}'
```

## Test

```sh
npm test
npm run coverage
REPORT_GAS=1 npm test
slither . --filter-paths node_modules --disable-color
```

## Deploy to Sepolia

```sh
npm run deploy:sepolia
```
