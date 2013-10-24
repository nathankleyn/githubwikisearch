var redisClient, jobs, repoExistsInRedis, executeSearch,
    getMatchingLinesForResults, getMatchingLineForResult, cloneRepo,
    _ = require('underscore'),
    cluster = require('cluster'),
    express = require('express'),
    fs = require('fs'),
    kue = require('kue'),
    lazy = require('lazy'),
    path = require('path'),
    q = require('q'),
    reds = require('reds'),
    redis = require('redis'),

    app = express(),
    redisClient = redis.createClient(),

    REDIS_PREFIX = 'githubwikisearch-',
    ALLOWED_USERNAME_REPO_REGEX = /^[a-z0-9-_]+$/i;

if (cluster.isMaster) {
  var workerCount = 1;

  if (app.settings.env === 'production') {
    workerCount = require('os').cpus().length;
  }

  for (var i = 0; i < workerCount; i++) {
    cluster.fork();
  }
}
else {
  app.set('view engine', 'jade');
  app.disable('x-powered-by');

  app.use(express.bodyParser());
  app.use('/static', express.static('./public'));

  jobs = kue.createQueue();

  /**
   * Pretty homepage goodness.
   */
  app.get('/', function(req, res) {
    res.render('index');
  });

  app.post('/', function(req, res) {
    res.render('code', {
      username: req.body.username,
      repo: req.body.repo
    });
  });

  app.get('/search', function(req, res) {
    var dfd, search,
        dfds = [],
        username = req.query['wiki-username'],
        repo = req.query['wiki-repo'],
        query = req.query['wiki-q'];

    if (username == null || username === "" || !ALLOWED_USERNAME_REPO_REGEX.test(username)) {
      res.send('Invalid username');
    }

    if (repo === null || repo === "" || !ALLOWED_USERNAME_REPO_REGEX.test(repo)) {
      res.send('Invalid repo name');
    }

    search = reds.createSearch(username + '/' + repo);

    repoExistsInRedis(repo).then(function(exists) {
      if (exists) {
        return executeSearch(search, username, repo, query).then(_.partial(getMatchingLinesForResults, username, repo));
      }
      else {
        return cloneRepo(username, repo);
      }
    }).then(function(results) {
      res.render('search', {
        query: query,
        results: results,
        username: username,
        repo: repo
      });
    }).fail(function(err) {
      console.error(err);
      next(err);
    })
  });

  repoExistsInRedis = function(repo) {
    var dfd = q.defer();

    redisClient.hsetnx(REDIS_PREFIX + 'repos', repo, +new Date(), function(err, wasSet) {
      if (err) {
        dfd.reject(err);
        return false;
      }

      dfd.resolve(!wasSet);
    });

    return dfd.promise;
  };

  cloneRepo = function(username, repo) {
    var dfd = q.defer(),
      job = jobs.create('cloneRepo', {
        title: 'Clone the "' + username + '/' + repo + '" GitHub repo.',
        username: username,
        repo: repo
      }).save();

    dfd.resolve([]);
  }

  executeSearch = function(search, username, repo, query) {
    var dfd = q.defer();

    search.query(query).end(function(err, ids) {
      if (err) {
        dfd.reject(new Error('Search could not be run, looks to be a problem on our end! Bear with us as we fix it!'));
        return false;
      }

      dfd.resolve(ids);
    });

    return dfd.promise;
  };

  getMatchingLinesForResults = function(username, repo, ids) {
    var dfds = ids.reduce(function(acc, id) {
      var dfd = getMatchingLineForResult(username, repo, id);

      if (dfd) {
        acc.push(dfd);
      }

      return acc;
    }, []);

    return q.all(dfds);
  };

  getMatchingLineForResult = function(username, repo, id) {
    var dfd = q.defer(),
        parts = id.split(':'),
        file = parts[0],
        line = parseInt(parts[1], 10),
        pageName = path.basename(file, path.extname(file)),
        url = "https://github.com/" + username + '/' + repo + '/wiki';

    if (pageName === '_Sidebar' || pageName === '_Footer' || pageName === '_Header') {
      return;
    }

    if (pageName !== 'Home') {
      url += '/' + pageName;
    }

    lazy(fs.createReadStream(file))
      .lines
      .skip(line - 1)
      .take(1)
      .map(function(line) {
        return line.toString();
      })
      .join(function(lines) {
        dfd.resolve({
          url: url,
          title: pageName.replace(/-/g, ' '),
          content: lines.join('\n')
        });
      });

    return dfd.promise;
  };

  console.log('Worker ' + cluster.worker.id + ' is listening on port 3000.');
  app.listen(3000);
}