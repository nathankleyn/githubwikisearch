var repoString, repoPath, updateRepos, createIndexRepoJob,
    _ = require('underscore'),
    childProcess = require('child_process'),
    cluster = require('cluster'),
    fs = require('fs'),
    glob = require('glob'),
    kue = require('kue'),
    reds = require('reds');
    q = require('q'),
    shellEscape = require('shell-escape'),

    exec = childProcess.exec,
    jobs = kue.createQueue(),

    REDIS_PREFIX = 'githubwikisearch-',
    REPOS_PATH = '/repos';

if (cluster.isMaster) {
  var workerCount = require('os').cpus().length;

  for (var i = 0; i < workerCount; i++) {
    cluster.fork();
  }

  updateRepos = function() {
    fs.readdir(REPOS_PATH, function(err, files) {
      files.forEach(function(file) {
        var parts = file.split('_-_'),
            username = parts[0],
            repo = parts[1];

        jobs.create('updateRepo', {
          title: 'Update the "' + username + '/' + repo + '" GitHub repo.',
          username: username,
          repo: repo
        }).save();
      });
    });
  };

  // Schedule an update or all repos every 15 minutes.
  setInterval(updateRepos, 1000 * 60 * 15);
  updateRepos();
}
else {
  repoString = function(username, repo) {
    return username + '/' + repo;
  };

  repoPath = function(username, repo) {
    return REPOS_PATH + '/' + username + '_-_' + repo;
  };

  createIndexRepoJob = function(username, repo) {
    jobs.create('indexRepo', {
      title: 'Index the "' + username + '/' + repo + '" GitHub repo.',
      username: username,
      repo: repo
    }).save();
  };

  jobs.process('cloneRepo', function(job, done) {
    var username = job.data.username,
        repo = job.data.repo,
        gitUrl = 'git://github.com/' + repoString(username, repo) + '.wiki.git',
        destinationPath = repoPath(username, repo);

    console.log('Clone repo job running...');

    fs.exists(destinationPath, function(exists) {
      if (exists) {
        // Just say it's done, as it's already there on disk even if Redis
        // didn't know about it.
        done();
        return;
      }

      exec(shellEscape(['git', 'clone', gitUrl, destinationPath]), {
        cwd: REPOS_PATH
      }, function(err, stdout, stderr) {
        if (err) {
          done(err);
          return false;
        }

        createIndexRepoJob(username, repo);
        done();
      });
    });
  });

  jobs.process('indexRepo', function(job, done) {
    var username = job.data.username,
        repo = job.data.repo,
        thisRepoString = repoString(username, repo),
        thisRepoPath = repoPath(username, repo);

    console.log('Index repo job running...');

    // FIXME: Do we actually need to remove existing keys from Redis here?

    glob(thisRepoPath + '/**/*.*', function(err, files) {
      var dfds = [];

      if (err) {
        done(err);
        return false;
      }

      if (!files) {
        done(new Error('No Markdown files found in "' + thisRepoString + '".'));
      }

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
            return false;
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

  // Code to update the repos.
  jobs.process('updateRepo', function(job, done) {
    var username = job.data.username,
        repo = job.data.repo,
        thisRepoString = repoString(username, repo),
        thisRepoPath = repoPath(username, repo);

    // FIXME: Check whether the folder exists?

    console.log('Update repo job running...');

    exec('git fetch', {
      cwd: thisRepoPath
    }, function(err, stdout, stderr) {
      if (err) {
        done(err);
        return false;
      }

      exec('git reset --hard origin/master', {
        cwd: thisRepoPath
      }, function(err, stdout, stderr) {
        if (err) {
          done(err);
          return false;
        }

        createIndexRepoJob(username, repo);
        done();
      })
    });
  });
}