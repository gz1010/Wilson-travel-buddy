// `npm test` is offline: it never needs a model. The live suite in
// src/core/__live__ talks to a real llama-server and runs only with
// `npm run test:live` (LIVE=1).
module.exports = {
  preset: 'react-native',
  testPathIgnorePatterns: ['/node_modules/', ...(process.env.LIVE ? [] : ['/__live__/'])],
};
