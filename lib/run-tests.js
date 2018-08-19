var compile = require("node-elm-compiler").compile,
    chokidar = require("chokidar"),
    fs = require("fs-extra"),
    glob = require("glob"),
    murmur = require("murmur-hash-js"),
    supportsColor = require("supports-color"),
    Runner = require("./runner.js"),
    Supervisor = require("./supervisor.js"),
    path = require("path"),
    Init = require("./init.js"),
    child_process = require("child_process");

var projectRootDir;
var testRootDir;
var elmJsonPath;
var generatedCodeDir = path.resolve(
  path.join("elm-stuff", "generated-code", "elm-community", "elm-test")
);

module.exports = function runTests(report, pathToElmBinary, args, testFile) {
  function infoLog(msg) {
    if (report === "console") {
      console.log(msg);
    }
  }

  function spawnCompiler(cmd, args, opts) {
    var compilerOpts = _.defaults(
      {
        stdio: [
          process.stdin,
          report === "console" ? process.stdout : "ignore",
          process.stderr
        ]
      },
      opts
    );

    return spawn(cmd, args, compilerOpts);
  }

  var dest = path.resolve(path.join(generatedCodeDir, "elmTestOutput.js"));

  var compileProcess = compile([testFile], {
    output: dest,
    verbose: args.verbose,
    spawn: spawnCompiler,
    pathToElm: pathToElmBinary,
    warn: args.warn,
    processOpts: processOptsForReporter(args.report)
  });

  compileProcess.on("close", function(exitCode) {
    if (exitCode !== 0) {
      console.error("Compilation failed for", testFile);
      if (!args.watch) {
        process.exit(exitCode);
      }
    } else {
      var initialSeed = null;

      if (args.seed !== undefined) {
        initialSeed = args.seed;
      }
      prepareCompiledJsFile(initialSeed, report, dest);

      Supervisor.run(
        packageInfo.version,
        report,
        processes,
        dest,
        args.watch,
        isMachineReadableReporter(report)
      );
    }
  });
}

function prepareCompiledJsFile(initialSeed, report, dest) {
  // TODO read files in parallel using Promise.all
  var before = fs.readFileSync(
    path.join(__dirname, "..", "templates", "before.js"),
    "utf8"
  );
  var after = fs.readFileSync(
    path.join(__dirname, "..", "templates", "after.js"),
    "utf8"
  );
  var content = fs.readFileSync(dest, "utf8");

  var finalContent = [
    before,
    "var Elm = (function(module) { ",
    content,
    "return this.Elm;",
    "})({});",
    "var initialSeed = " + String(initialSeed) + ";",
    'var report = "' + report + '";',
    "var pipeFilename = " + JSON.stringify(pipeFilename) + ";",
    after
  ].join("\n");

  fs.writeFileSync(dest, finalContent);
}

function checkNodeVersion() {
  var nodeVersionString = process.versions.node;
  var nodeVersion = _.map(_.split(nodeVersionString, "."), _.parseInt);

  if (
    (nodeVersion[0] === 0 && nodeVersion[1] < 11) ||
    (nodeVersion[0] === 0 && nodeVersion[1] === 11 && nodeVersion[2] < 13)
  ) {
    console.log("using node v" + nodeVersionString);
    console.error(
      "elm-test requires node v4.7.0 or greater - upgrade the installed version of node and try again"
    );
    process.exit(1);
  }
}

function globify(filename) {
  return glob.sync(filename, {
    nocase: true,
    ignore: "**/elm-stuff/**",
    nodir: false
  });
}

function globifyWithRoot(root, filename) {
  return glob.sync(filename, {
    root: root,
    nocase: true,
    ignore: "**/elm-stuff/**",
    nodir: false
  });
}

function generatePackageJson(filePathArgs) {
  // TODO we don't want to do this every single time. Instead,
  // verify that the generated elm.json is there, with the
  // expected version number. Iff the version number is wrong, regenerate.
  var generatedSrc = path.join(generatedCodeDir, "src");
  fs.mkdirpSync(generatedCodeDir);
  fs.mkdirpSync(generatedSrc);

  var projectElmJson = {};
  try {
    projectElmJson = fs.readJsonSync(elmJsonPath);
  } catch (err) {
    console.error("Error reading elm.json: " + err);
    process.exit(1);
  }
  var isPackageProject = projectElmJson.type === "package";

  var testElmJson = {
    type: "application",
    "source-directories": [], // these are added below
    "elm-version": "0.19.0",
    "dependencies": {
      "direct": {},
      "indirect": {}
    },
    "test-dependencies": {
      "direct": {},
      "indirect": {}
    }
  };

  function addDirectDependencies(deps) {
    Object.keys(deps).forEach(function(name) {
      var version = deps[name];
      if (isPackageProject) {
        // Use the lowest version in the range.
        // NOTE: technically this doesn't work if someone does something weird like:
        //
        // "2.0.0 < v < 3.0.0"
        //
        // ...but we're choosing not to support that right now.
        version = version.split(" ")[0];
      }
      if (testElmJson["dependencies"]["direct"].hasOwnProperty(name)) {
        var existingVersion = testElmJson["dependencies"]["direct"][name];

        // If we have a clash, choose the higher of the two versions.
        // This may not work! It's entirely possible that the result won't
        // compile. We're going to try it and see what happens.
        version = Version.getHigherVersion(version, existingVersion);
      }
      testElmJson["dependencies"]["direct"][name] = version;
    });
  }

  function addIndirectDependencies(deps) {
    Object.keys(deps).forEach(function(name) {
      if (testElmJson["dependencies"]["direct"].hasOwnProperty(name)) {
        // already a normal dep
      } else {
        var version = deps[name];

        if (testElmJson["dependencies"]["indirect"].hasOwnProperty(name)) {
          var existingVersion = testElmJson["dependencies"]["indirect"][name];

          // If we have a clash, choose the higher of the two versions.
          // This may not work! It's entirely possible that the result won't
          // compile. We're going to try it and see what happens.
          version = Version.getHigherVersion(version, existingVersion);
        }

        testElmJson["dependencies"]["indirect"][name] = version;
      }
    });
  }

  var nodeTestRunnerElmJsonPath = path.resolve(path.join(__dirname, "..", "elm.json"));
  var nodeTestRunnerElmJson = fs.readJsonSync(nodeTestRunnerElmJsonPath);
  // we want to use the version of elm-explorations/test that the user
  // specifies in their own test-dependencies. everything else needs to
  // be included for the test runner to compile.
  delete nodeTestRunnerElmJson.dependencies.direct['elm-explorations/test'];
  addDirectDependencies(nodeTestRunnerElmJson["dependencies"]["direct"]);
  addIndirectDependencies(nodeTestRunnerElmJson["dependencies"]["indirect"]);

  if (isPackageProject) {
    addDirectDependencies(projectElmJson["dependencies"]);
    addDirectDependencies(projectElmJson["test-dependencies"]);
    // package projects don't explicitly list their transitive dependencies,
    // to we have to figure out what they are.  We write the elm.json that
    // we have so far, and run elm to see what it thinks is missing.
    fs.writeFileSync(
      path.join(generatedCodeDir, "elm.json"),
      JSON.stringify(testElmJson, null, 4)
    );
    var missingDeps = askElmForMissingTransitiveDependencies(generatedCodeDir);
    addIndirectDependencies(missingDeps);
  } else {
    addDirectDependencies(projectElmJson["dependencies"]["direct"]);
    addIndirectDependencies(projectElmJson["dependencies"]["indirect"]);
    addDirectDependencies(projectElmJson["test-dependencies"]["direct"]);
    addIndirectDependencies(projectElmJson["test-dependencies"]["indirect"]);
  }

  // Make all the source-directories absolute, and introduce a new one.
  var projectSourceDirs;
  if (isPackageProject) {
    projectSourceDirs = [ "./src" ];
  } else {
    projectSourceDirs = projectElmJson["source-directories"];
  }
  var sourceDirs = projectSourceDirs.map(
    function(src) {
      return path.resolve(path.join(projectRootDir, src));
    }
  ).concat(testRootDir);

  testElmJson["source-directories"] = [
    // Include elm-stuff/generated-sources - since we'll be generating sources in there.
    generatedSrc,

    // NOTE: we must include node-test-runner's Elm source as a source-directory
    // instead of adding it as a dependency so that it can include port modules
    path.resolve(path.join(__dirname, "..", "src"))
  ].concat(sourceDirs);

  // When running node-test-runner's own test suite, the node-test-runner/src folder
  // will get added twice: once because it's the source-directory of the packge being tested,
  // and once because elm-test will always add it.
  // To prevent elm from being confused, we need to remove the duplicate when this happens.
  testElmJson["source-directories"] =
    testElmJson["source-directories"].filter(function(value, index, self) {
      return self.indexOf(value) === index;
    });

  // Generate the new elm.json
  fs.writeFileSync(
    path.join(generatedCodeDir, "elm.json"),
    JSON.stringify(testElmJson, null, 4)
  );

  return [generatedSrc, sourceDirs];
}

function askElmForMissingTransitiveDependencies(pathtoElmProject) {
  var result = child_process.spawnSync(pathToElmBinary, ["make", "--report=json"], {
    silent: true,
    cwd: pathtoElmProject
  });

  // TODO: hopefully the next Elm 0.19 beta will print the JSON to stdout instead
  var output = result.stderr.toString();

  // TODO: hopefully the next Elm 0.19 beta will not have this message (only occurs on linux) mixed in with the JSON output
  output = output.replace(/^elm:.*no version information available \(required by elm\)\n/, '');

  var report = JSON.parse(output);
  if (report.type === "error" && report.title === "NO INPUT") {
    // all transtive dependencies are listed already (elm is complaining that we didn't tell it which .elm file to build, which happens after the dependency validations)
    return {};
  } else if (report.type === "error" && report.title === "MISSING DEPENDENCIES") {
    var missingDeps = {};
    // parse the missing dependencies and versions from the error report
    report.message[1].string.replace(/"([^"]*)": "([^"]*)"/g, function(_, name, version) {
      missingDeps[name] = version;
    })
    return missingDeps;
  } else {
    console.error("elm-test internal error: got an unexpected result from 'elm make' when validating transitive dependencies.  Please report this at https://github.com/rtfeldman/node-test-runner/issues");
    process.exit(1);
    return {}; // This makes flow happy because it doesn't know process.exit will stop everything
  }
}

function generateAndRunTests(tests, filePathArgs, generatedSrc, getGlobs) {
  // Building things like:
  //
  // import MyTests
  //
  // MyTests.suite
  var imports = _.map(tests, function(test) {
    return "import " + test.name;
  });
  var testList = _.map(tests, function(mod) {
    return (
      '    Test.describe "' +
      mod.name +
      '" [' +
      _.map(mod.tests, function(test) {
        return mod.name + "." + test;
      }).join(",\n    ") +
      "]"
    );
  });

  if (testList.length === 0) {
    var errorMessage =
      filePathArgs.length > 0
        ? "I couldn't find any exposed values of type Test in files matching \"" +
          filePathArgs.toString() +
          '"\n\nMaybe try running elm-test with no arguments?'
        : "I couldn't find any exposed values of type Test in any *.elm files in the test/ (or tests/) directory of your project's root directory.\n\nTo generate some initial tests to get things going, run elm-test init";

    console.error(errorMessage);
    process.exit(1);
  }

  function sanitizedToString(str) {
    return '"' + str.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  function getReportCode() {
    switch (args.report) {
      case "json":
        return "JsonReport";
      case "junit":
        return "JUnitReport";
      default:
        if (supportsColor) {
          return "(ConsoleReport UseColor)";
        } else {
          return "(ConsoleReport Monochrome)";
        }
    }
  }

  var fuzz = parseInt(args.fuzz);
  var seed = parseInt(args.seed);
  var opts = {
    fuzz: isNaN(fuzz) ? "Nothing" : "Just " + fuzz,
    seed: isNaN(seed) ? "Nothing" : "Just " + seed,
    report: getReportCode(),
    paths: filePathArgs.map(sanitizedToString).join(",")
  };

  var optsCode =
    "{ runs = " +
    opts.fuzz +
    ", report = " +
    opts.report +
    ", seed = " +
    opts.seed +
    ", processes = " +
    processes +
    ", paths = [" +
    opts.paths +
    "]}";

  var testFileBody = [
    imports.join("\n"),
    "",
    "import Test.Reporter.Reporter exposing (Report(..))",
    "import Console.Text exposing (UseColor(..))",
    "import Test.Runner.Node",
    "import Test",
    "import Json.Encode",
    "",
    "main : Test.Runner.Node.TestProgram",
    "main =",
    "    [ " + testList.join(", ") + " ]",
    "        |> Test.concat",
    "        |> Test.Runner.Node.runWithOptions " + optsCode
  ].join("\n");

  // Generate a filename that incorporates the hash of file contents.
  // This way, if you run e.g. `elm-test Foo.elm` and then `elm-test Bar.elm`
  // and then re-run `elm-test Foo.elm` we still have a cached `Main` for
  // `Foo.elm` (assuming none of its necessary imports have changed - and
  // why would they?) so we don't have to recompile it.
  var salt = murmur.murmur3(testFileBody);
  var moduleName = "Main" + salt;
  var mainPath = path.join(generatedSrc, "Test", "Generated");
  var mainFile = path.join(mainPath, moduleName + ".elm");
  // We'll be putting the generated Main in something like this:
  //
  // my-project-name/elm-stuff/generated-code/elm-community/elm-test/src/Test/Generated/Main123456.elm
  var testFileContents = [
    "module Test.Generated." + moduleName + " exposing (main)",
    testFileBody
  ].join("\n\n");

  // Make sure src/Test/Generated/ exists so we can write the file there.
  fs.mkdirpSync(mainPath);

  // Always write the file, in order to update its timestamp. This is important,
  // because if we run `elm-make Main123456.elm` and that file's timestamp did
  // not change, elm-make will short-circuit and not recompile *anything* - even
  // if some of Main's dependencies (such as an individual test file) changed.
  fs.writeFileSync(mainFile, testFileContents);

  if (args.watch) {
    infoLog("Running in watch mode");

    var watchedPaths = getWatchPaths(projectRootDir);
    var watcher = chokidar.watch(watchedPaths, {
      awaitWriteFinish: {
        stabilityThreshold: 500
      },
      ignoreInitial: true,
      ignored: /(\/|^)elm-stuff(\/|$)/
    });

    var eventNameMap = {
      add: "added",
      addDir: "added",
      change: "changed",
      unlink: "removed",
      unlinkDir: "removed"
    };

    watcher.on("all", function(event, filePath) {
      var relativePath = path.relative(testRootDir, filePath);
      var eventName = eventNameMap[event] || event;

      infoLog("\n" + relativePath + " " + eventName + ". Rebuilding!");

      // TODO if a previous run is in progress, wait until it's done.
      runTests(report, pathToElmBinary, args, mainFile);
    });
  }

  runTests(report, pathToElmBinary, args, mainFile);
}

function getWatchPaths(projectRootDir) {
  var watchedSourcePaths;
  var elmJson = fs.readJsonSync(path.join(projectRootDir, "elm.json"), "utf8");
  if (elmJson["type"] === "package") {
    watchedSourcePaths = [ "./src" ];
  } else {
    watchedSourcePaths = elmJson["source-directories"];
  }
  var watchedTestPaths = path.join(projectRootDir, "tests");
  var watchedPaths = watchedSourcePaths.concat(watchedTestPaths).map(function(sourcePath) {
    return path.resolve(projectRootDir, sourcePath) + "/**/*.elm";
  });
  return watchedPaths;
}
