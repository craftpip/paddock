// Drop a service from the require cache so the next require re-reads the
// environment (several services compute paths and guards when they load).
//
//   require('./helpers/evict')('../services/vm-manager');
//
// A service that is a directory of modules is dropped WHOLE: evicting only its
// index would hand back the same sibling modules, still holding the values
// they computed under the previous environment.
const path = require('node:path');

module.exports = function evict(request) {
  const target = require.resolve(path.resolve(__dirname, '..', request));
  if (path.basename(target) !== 'index.js') {
    delete require.cache[target];
    return;
  }
  const dir = path.dirname(target) + path.sep;
  for (const key of Object.keys(require.cache)) if (key.startsWith(dir)) delete require.cache[key];
};
