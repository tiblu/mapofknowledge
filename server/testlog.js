// TESTLOG — temporary test session logger. To remove: delete this file,
// then search for "// TESTLOG" across the codebase and remove those lines.
const fs   = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'testlog.txt');

module.exports = function testlog(cat, data) {
  const line = JSON.stringify({ ts: new Date().toISOString(), cat, ...data }) + '\n';
  fs.appendFile(FILE, line, () => {});
};
