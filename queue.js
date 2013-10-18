var jobs, repoString, repoPath,
    childProcess = require('child_process'),
    cluster = require('cluster'),
    fs = require('fs'),
    glob = require('glob'),
    kue = require('kue'),
    reds = require('reds');
    q = require('q'),
    shellEscape = require('shell-escape'),

    exec = childProcess.exec,

    REDIS_PREFIX = 'githubwikisearch-',
    REPOS_PATH = '/repos';

if (cluster.isMaster) {
  var workerCount = require('os').cpus().length;

  for (var i = 0; i < workerCount; i++) {
    cluster.fork();
  }
}
else {
  jobs = kue.createQueue();

  repoString = function(username, repo) {
    return username + '/' + repo;
  };

  repoPath = function(username, repo) {
    return REPOS_PATH + '/' + username + '.' + repo;
  };

  jobs.process('repoClone', function(job, done) {
    var gitUrl = 'git@github.com:' + repoString(job.data.username, job.data.repo) + '.wiki.git',
        destinationPath = repoPath(job.data.username, job.data.repo);

    exec(shellEscape(['git', 'clone', gitUrl, destinationPath]), {
      cwd: REPOS_PATH
    }, function(err, stdout, stderr) {
      if (err) {
        done(err);
      }

      done();
    });
  });

  jobs.process('indexRepo', function(job, done) {
    var username = job.data.username,
        repo = job.data.repo,
        thisRepoString = repoString(username, repo),
        thisRepoPath = repoPath(username, repo);

    glob(thisRepoPath + '/**/*.*', function(err, files) {
      var dfds = [];

      if (err) {
        done(err);
      }

      if (!files) {
        done(new Error('No Markdown files found in "' + thisRepoString + '".'));
      }

      console.log(files);

      files.forEach(function(file) {
        // We don't touch anything with .git in the filename. That will ignore
        // .git and .gitignore in a very speedy fashion, although it may ignore
        // things wrongly if they have .git in the path - seems unlikely.
        if (file.indexOf('.git') !== -1) {
          return;
        }

        var dfd = q.defer();

        fs.readFile(file, {
          encoding: "utf8"
        }, function(err, contents) {
          var lines, search;

          if (err) {
            dfd.reject(err);
          }

          lines = contents.split('\n');
          search = reds.createSearch(thisRepoString);

          lines.forEach(function(line, i) {
            search.index(line, file + ':' + (i + 1));
          });

          done();
        });

        dfds.push(dfd);
      });

      q.all(dfds).then(function() {
        done();
      }, function(errs) {
        done(errs);
      });
    });
  });
}