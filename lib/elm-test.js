// @flow

var packageInfo = require("../package.json");
var pipeFilename = require("./pipe-filename.js");
var Version = require("./version.js");
var Install = require("./install.js");
var RunTests = require("./run-tests.js");
var dns = require("dns");

var processTitle = "elm-test";

process.title = processTitle;

process.on("uncaughtException", function(error) {
  if (/ an argument in Javascript/.test(error)) {
    // Handle arg mismatch between js and elm code. Expected message from Elm:
    // "You are giving module `Main` an argument in JavaScript.
    // This module does not take arguments though! You probably need to change the
    // initialization code to something like `Elm.Test.Generated.Main.fullscreen()`]"
    console.error("Error starting the node-test-runner.");
    console.error(
      "Please check your Javascript 'elm-test' and Elm 'node-test-runner' package versions are compatible"
    );
    process.exit(1);
  } else {
    console.error("Unhandled exception while running the tests:", error);
    process.exit(1);
  }
});

var fs = require("fs-extra"),
  os = require("os"),
  glob = require("glob"),
  path = require("path"),
  _ = require("lodash"),
  spawn = require("cross-spawn"),
  minimist = require("minimist");

var args = minimist(process.argv.slice(2), {
  boolean: ["warn", "version", "help", "watch"],
  string: ["compiler", "seed", "report", "fuzz"]
});
var processes = Math.max(1, os.cpus().length);

// Recursively search directories for *.elm files, excluding elm-stuff/
function resolveFilePath(filename) {
  var candidates;

  if (!fs.existsSync(filename)) {
    candidates = [];
  } else if (fs.lstatSync(filename).isDirectory()) {
    candidates = _.flatMap(
      glob.sync("/**/*.elm", {
        root: filename,
        nocase: true,
        ignore: "/**/elm-stuff/**",
        nodir: true
      }),
      resolveFilePath
    );
  } else {
    candidates = [path.resolve(filename)];
  }

  // Exclude everything having anything to do with elm-stuff
  return candidates.filter(function(candidate) {
    return candidate.split(path.sep).indexOf("elm-stuff") === -1;
  });
}

var pathToElmBinary = "elm";

if (args.compiler !== undefined) {
  pathToElmBinary = path.resolve(args.compiler);

  if (!pathToElmBinary) {
    console.error(
      "The --compiler option must be given a path to an elm-make executable."
    );
    process.exit(1);
  }
}

function printUsage(str) {
  console.log("Usage: elm-test " + str + "\n");
}

if (args.help) {
  var exampleGlob = path.join("tests", "**", "*.elm");

  [
    "init # Create example tests",
    "install PACKAGE # Like `elm install PACKAGE`, except it installs to \"test-dependencies\" in your elm.json",
    "TESTFILES # Run TESTFILES, for example " + exampleGlob,
    "[--compiler /path/to/compiler] # Run tests",
    "[--seed integer] # Run with initial fuzzer seed",
    "[--fuzz integer] # Run with each fuzz test performing this many iterations",
    "[--report json, junit, or console (default)] # Print results to stdout in given format",
    "[--version] # Print version string and exit",
    "[--watch] # Run tests on file changes"
  ].forEach(printUsage);

  process.exit(1);
}

if (args.version) {
  console.log(require(path.join(__dirname, "..", "package.json")).version);
  process.exit(0);
}

if (args._[0] === "install") {
  var packageName = args._[1];

  if (typeof packageName === "string") {
    Install(packageName).then(function() {
      console.log("Done");
      process.exit(0);
    }).catch(function(err) {
      console.error(err);
      process.exit(1);
    });
  } else {
    console.error(
      "What package should I install? I was expecting something like this:\n\n    elm-test install elm/regex\n"
    );
    process.exit(1);
  }
} else {
  var report;

  if (
    args.report === "console" ||
    args.report === "json" ||
    args.report === "junit"
  ) {
    report = args.report;
  } else if (args.report !== undefined) {
    console.error(
      "The --report option must be given either 'console', 'junit', or 'json'"
    );
    process.exit(1);
  } else {
    report = "console";
  }

  RunTests(report, pathToElmBinary, args);
}
