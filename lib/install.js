var temp = require("temp");

module.exports = function install(packageName) {
  return new Promise(function(resolve, reject) {

    console.log("Installing:", packageName);

    resolve();
  });
}
