var redisClient, jobs,
    _ = require('underscore'),
    cluster = require('cluster'),
    express = require('express'),
    kue = require('kue'),
    path = require('path'),
    reds = require('reds'),
    redis = require('redis'),

    app = express(),
    redisClient = redis.createClient(),

    REDIS_PREFIX = 'githubwikisearch-',
    ALLOWED_USERNAME_REPO_REGEX = /^[a-z0-9]+$/i;

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

  jobs = kue.createQueue();

  /**
   * Pretty homepage goodness.
   */
  app.get('/', function(req, res) {
    res.send(403);
  });

  /**
   * Add a repository to the searchable ones.
   */
  app.post('/add', function(req, res, next) {
    // FIXME: Sanitise these strings.
    var username = req.body.username,
        repo = req.body.repo;

    if (username == null || username === "" || !ALLOWED_USERNAME_REPO_REGEX.test(username)) {
      res.send('Invalid username');
    }

    if (repo === null || repo === "" || !ALLOWED_USERNAME_REPO_REGEX.test(repo)) {
      res.send('Invalid repo name');
    }

    redisClient.hsetnx(REDIS_PREFIX + 'repos', repo, +new Date(), function(err, wasSet) {
      if (err) {
        next(err);
        return false;
      }

      if (wasSet) {
        var job = jobs.create('cloneRepo', {
          title: 'Clone the "' + username + '/' + repo + '" GitHub repo.',
          username: username,
          repo: repo
        }).save();

        // render success
        res.send('success');
      }
      else {
        // tell them that repo is already added
        res.send('repo already added');
      }
    });
  });

  app.get('/search', function(req, res) {
    // FIXME: Sanitise these strings.
    var files, urls,
        username = req.query['wiki-username'],
        repo = req.query['wiki-repo'],
        q = req.query.q,

        search = reds.createSearch(username + '/' + repo);

    search.query(q).end(function(err, ids) {
      if (err) {
        next(new Error('Search could not be run, looks to be a problem on our end! Bear with us as we fix it!'));
        return false;
      }

      files = _.uniq(ids.map(function(id) {
        return id.split(':')[0];
      }));

      urls = files.reduce(function(acc, file) {
        var ext = path.extname(file),
            pageName = path.basename(file, ext),
            url = "https://github.com/" + username + '/' + repo + '/wiki';

        if (pageName === '_Sidebar' || pageName === '_Footer' || pageName === '_Header') {
          return acc;
        }

        if (pageName !== 'Home') {
          url += '/' + pageName;
        }

        acc.push(url);
        return acc;
      }, []);

      res.render('search', {
        query: q,
        urls: urls
      });
    });
  });

  console.log('Worker ' + cluster.worker.id + ' is listening on port 3000.');
  app.listen(3000);
}