var kue = require('kue');

kue.app.set('title', 'GitHubWikiSearch Jobs');
kue.app.listen(3001);