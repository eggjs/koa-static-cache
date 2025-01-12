import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from '@eggjs/supertest';
import { LRU } from 'ylru';
import { Application as Koa } from '@eggjs/koa';
import { staticCache } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = new Koa();
const files: Record<string, any> = {};
app.use(staticCache(path.join(__dirname, '..'), {
  alias: {
    '/package': '/package.json',
  },
  filter(file: string) {
    return !file.includes('node_modules');
  },
}, files));

const server = http.createServer(app.callback());

const app2 = new Koa();
app2.use(staticCache({
  dir: path.join(__dirname, '..'),
  buffer: true,
  filter(file: string) {
    return !file.includes('node_modules');
  },
}));
const server2 = http.createServer(app2.callback());

const app3 = new Koa();
app3.use(staticCache(path.join(__dirname, '..'), {
  buffer: true,
  gzip: true,
  filter(file: string) {
    return !file.includes('node_modules');
  },
}));
const server3 = http.createServer(app3.callback());

const app4 = new Koa();
const files4: Record<string, any> = {};
app4.use(staticCache(path.join(__dirname, '..'), {
  gzip: true,
  filter(file: string) {
    return !file.includes('node_modules');
  },
  files: files4,
}));

const server4 = http.createServer(app4.callback());

const app5 = new Koa();
app5.use(staticCache({
  buffer: true,
  prefix: '/static',
  dir: path.join(__dirname, '..'),
  filter(file: string) {
    return !file.includes('node_modules');
  },
}));
const server5 = http.createServer(app5.callback());

describe('Static Cache', () => {
  it('should dir priority than options.dir', function(done) {
    const app = new Koa();
    app.use(staticCache(path.join(__dirname, '..'), {
      dir: __dirname,
    }));
    const server = app.listen();
    request(server)
      .get('/index.js')
      .expect(200, done);
  });

  it('should default options.dir works fine', function(done) {
    const app = new Koa();
    app.use(staticCache({
      dir: path.join(__dirname, '..'),
    }));
    const server = app.listen();
    request(server)
      .get('/index.js')
      .expect(200, done);
  });

  it('should accept abnormal path', function(done) {
    const app = new Koa();
    app.use(staticCache({
      dir: path.join(__dirname, '..'),
    }));
    const server = app.listen();
    request(server)
      .get('//index.js')
      .expect(200, done);
  });

  it('should default process.cwd() works fine', function(done) {
    const app = new Koa();
    app.use(staticCache());
    const server = app.listen();
    request(server)
      .get('/index.js')
      .expect(200, done);
  });

  let etag: string;
  it('should serve files', function(done) {
    request(server)
      .get('/index.js')
      .expect(200)
      .expect('Cache-Control', 'public, max-age=0')
      .expect('Content-Type', /javascript/)
      .end(function(err, res) {
        if (err) return done(err);

        assert(res.headers['content-length']);
        assert(res.headers['last-modified']);
        assert(res.headers.etag);
        etag = res.headers.etag;

        done();
      });
  });

  it('should serve files as buffers', function(done) {
    request(server2)
      .get('/index.js')
      .expect(200)
      .expect('Cache-Control', 'public, max-age=0')
      .expect('Content-Type', /javascript/)
      .end(function(err, res) {
        if (err) return done(err);

        assert(res.headers['content-length']);
        assert(res.headers['last-modified']);
        assert(res.headers.etag);

        etag = res.headers.etag;

        done();
      });
  });

  it('should serve recursive files', function(done) {
    request(server)
      .get('/test/index.test.ts')
      .expect(200)
      .expect('Cache-Control', 'public, max-age=0')
      .expect('Content-Type', /video\/mp2t/)
      .end(function(err, res) {
        if (err) return done(err);

        assert(res.headers['content-length']);
        assert(res.headers['last-modified']);
        assert(res.headers.etag);

        done();
      });
  });

  it('should not serve hidden files', function(done) {
    request(server)
      .get('/.gitignore')
      .expect(404, done);
  });

  it('should support conditional HEAD requests', function(done) {
    request(server)
      .head('/index.js')
      .set('If-None-Match', etag)
      .expect(304, done);
  });

  it('should support conditional GET requests', function(done) {
    request(server)
      .get('/index.js')
      .set('If-None-Match', etag)
      .expect(304, done);
  });

  it('should support HEAD', function(done) {
    request(server)
      .head('/index.js')
      .expect(200, done);
  });

  it('should support 404 Not Found for other Methods to allow downstream',
    function(done) {
      request(server)
        .put('/index.js')
        .expect(404, done);
    });

  it('should ignore query strings', function(done) {
    request(server)
      .get('/index.js?query=string')
      .expect(200, done);
  });

  it('should alias paths', function(done) {
    request(server)
      .get('/package')
      .expect('Content-Type', /json/)
      .expect(200, done);
  });

  it('should be configurable via object', function(done) {
    files['/package.json'].maxAge = 1;

    request(server)
      .get('/package.json')
      .expect('Cache-Control', 'public, max-age=1')
      .expect(200, done);
  });

  it('should set the etag and content-md5 headers', function(done) {
    const pk = fs.readFileSync('package.json');
    const md5 = crypto.createHash('md5').update(pk).digest('base64');

    request(server)
      .get('/package.json')
      .expect('ETag', `"${md5}"`)
      .expect('Content-MD5', md5)
      .expect(200, done);
  });

  it('should set Last-Modified if file modified and not buffered', function(done) {
    setTimeout(function() {
      const readme = fs.readFileSync('README.md', 'utf8');
      fs.writeFileSync('README.md', readme, 'utf8');
      const mtime = fs.statSync('README.md').mtime;
      const md5 = files['/README.md'].md5;
      request(server)
        .get('/README.md')
        .expect(200, function(err, res) {
          if (err) return done(err);
          assert(res.headers['content-length']);
          assert(res.headers['last-modified']);
          assert(!res.headers.etag);
          assert.deepEqual(files['/README.md'].mtime, mtime);
          setTimeout(function() {
            assert.equal(files['/README.md'].md5, md5);
          }, 10);
          done();
        });
    }, 1000);
  });

  it('should set Last-Modified if file rollback and not buffered', function(done) {
    setTimeout(function() {
      const readme = fs.readFileSync('README.md', 'utf8');
      fs.writeFileSync('README.md', readme, 'utf8');
      const mtime = fs.statSync('README.md').mtime;
      const md5 = files['/README.md'].md5;
      request(server)
        .get('/README.md')
        .expect(200, function(err, res) {
          if (err) return done(err);
          assert(res.headers['content-length']);
          assert(res.headers['last-modified']);
          assert(!res.headers.etag);
          assert.deepEqual(files['/README.md'].mtime, mtime);
          setTimeout(function() {
            assert.equal(files['/README.md'].md5, md5);
          }, 10);
          done();
        });
    }, 1000);
  });

  it('should serve files with gzip buffer', function(done) {
    const index = fs.readFileSync(path.join(__dirname, '../CHANGELOG.md'));
    zlib.gzip(index, function(err, content) {
      if (err) return done(err);
      request(server3)
        .get('/CHANGELOG.md')
        .set('Accept-Encoding', 'gzip')
        .expect(200)
        .expect('Cache-Control', 'public, max-age=0')
        .expect('Content-Encoding', 'gzip')
        .expect('Content-Type', 'text/markdown; charset=utf-8')
        .expect('Content-Length', `${content.length}`)
        .expect('Vary', 'Accept-Encoding')
        .expect(index.toString())
        .end(function(err, res) {
          if (err) return done(err);
          assert(res.headers['content-length']);
          assert(res.headers['last-modified']);
          assert(res.headers.etag);

          etag = res.headers.etag;

          done();
        });
    });
  });

  it('should not serve files with gzip buffer when accept encoding not include gzip',
    function(done) {
      const index = fs.readFileSync('index.js');
      request(server3)
        .get('/index.js')
        .set('Accept-Encoding', '')
        .expect(200)
        .expect('Cache-Control', 'public, max-age=0')
        .expect('Content-Type', /javascript/)
        .expect('Content-Length', `${index.length}`)
        .expect('Vary', 'Accept-Encoding')
        .expect(index.toString())
        .end(function(err, res) {
          if (err) return done(err);
          assert(!res.headers['content-encoding']);
          assert(res.headers['content-length']);
          assert(res.headers['last-modified']);
          assert(res.headers.etag);
          done();
        });
    });

  it('should serve files with gzip stream', function(done) {
    const index = fs.readFileSync(path.join(__dirname, '../CHANGELOG.md'));
    zlib.gzip(index, function(err, content) {
      if (err) return done(err);
      assert(content.length > 0);
      request(server4)
        .get('/CHANGELOG.md')
        .set('Accept-Encoding', 'gzip')
        .expect(200)
        .expect('Cache-Control', 'public, max-age=0')
        .expect('Content-Encoding', 'gzip')
        .expect('Content-Type', /markdown/)
        .expect('Vary', 'Accept-Encoding')
        .expect(index.toString())
        .end(function(err, res) {
          if (err) return done(err);
          assert(!res.headers['content-length']);
          assert(res.headers['last-modified']);
          assert(res.headers.etag);

          etag = res.headers.etag;

          done();
        });
    });
  });

  it('should serve files with prefix', function(done) {
    request(server5)
      .get('/static/index.js')
      .expect(200)
      .expect('Cache-Control', 'public, max-age=0')
      .expect('Content-Type', /javascript/)
      .end(function(err, res) {
        if (err) return done(err);

        assert(res.headers['content-length']);
        assert(res.headers['last-modified']);
        assert(res.headers.etag);

        etag = res.headers.etag;

        done();
      });
  });

  it('should 404 when dynamic = false', function(done) {
    const app = new Koa();
    app.use(staticCache({ dynamic: false }));
    const server = app.listen();
    fs.writeFileSync('a.js', 'hello world');

    request(server)
      .get('/a.js')
      .expect(404, function(err) {
        fs.unlinkSync('a.js');
        done(err);
      });
  });

  it('should work fine when new file added in dynamic mode', function(done) {
    const app = new Koa();
    app.use(staticCache({ dynamic: true }));
    const server = app.listen();
    fs.writeFileSync('a.js', 'hello world');

    request(server)
      .get('/a.js')
      .expect(200, function(err) {
        fs.unlinkSync('a.js');
        done(err);
      });
  });

  it('should work fine when new file added in dynamic and prefix mode', function(done) {
    const app = new Koa();
    app.use(staticCache({ dynamic: true, prefix: '/static' }));
    const server = app.listen();
    fs.writeFileSync('a.js', 'hello world');

    request(server)
      .get('/static/a.js')
      .expect(200, function(err) {
        fs.unlinkSync('a.js');
        done(err);
      });
  });

  it('should work fine when new file added in dynamic mode with LRU', function(done) {
    const app = new Koa();
    const files = new LRU(1);
    app.use(staticCache({ dynamic: true, files }));
    const server = app.listen();
    fs.writeFileSync('a.js', 'hello world a');
    fs.writeFileSync('b.js', 'hello world b');
    fs.writeFileSync('c.js', 'hello world b');

    request(server)
      .get('/a.js')
      .expect(200, function(err) {
        assert(files.get('/a.js'));
        assert(!err);

        request(server)
          .get('/b.js')
          .expect(200, function(err) {
            assert(!files.get('/a.js'));
            assert(files.get('/b.js'));
            assert(!err);

            request(server)
              .get('/c.js')
              .expect(200, function(err) {
                assert(!files.get('/b.js'));
                assert(files.get('/c.js'));
                assert(!err);

                request(server)
                  .get('/a.js')
                  .expect(200, function(err) {
                    assert(!files.get('/c.js'));
                    assert(files.get('/a.js'));
                    assert(!err);
                    fs.unlinkSync('a.js');
                    fs.unlinkSync('b.js');
                    fs.unlinkSync('c.js');
                    done();
                  });
              });
          });
      });
  });

  it('should 404 when url without prefix in dynamic and prefix mode', function(done) {
    const app = new Koa();
    app.use(staticCache({ dynamic: true, prefix: '/static' }));
    const server = app.listen();
    fs.writeFileSync('a.js', 'hello world');

    request(server)
      .get('/a.js')
      .expect(404, function(err) {
        fs.unlinkSync('a.js');
        done(err);
      });
  });

  it('should 404 when new hidden file added in dynamic mode', function(done) {
    const app = new Koa();
    app.use(staticCache({ dynamic: true }));
    const server = app.listen();
    fs.writeFileSync('.a.js', 'hello world');

    request(server)
      .get('/.a.js')
      .expect(404, function(err) {
        fs.unlinkSync('.a.js');
        done(err);
      });
  });

  it('should 404 when file not exist in dynamic mode', function(done) {
    const app = new Koa();
    app.use(staticCache({ dynamic: true }));
    const server = app.listen();
    request(server)
      .get('/a.js')
      .expect(404, done);
  });

  it('should 404 when file not exist', function(done) {
    const app = new Koa();
    app.use(staticCache({ dynamic: true }));
    const server = app.listen();
    request(server)
      .get('/a.js')
      .expect(404, done);
  });

  it('should 404 when is folder in dynamic mode', function(done) {
    const app = new Koa();
    app.use(staticCache({ dynamic: true }));
    const server = app.listen();
    request(server)
      .get('/test')
      .expect(404, done);
  });

  it('should array options.filter works fine', function(done) {
    const app = new Koa();
    app.use(staticCache({
      dir: path.join(__dirname, '..'),
      filter: [ 'index.js' ],
    }));
    const server = app.listen();
    request(server)
      .get('/Makefile')
      .expect(404, done);
  });

  it('should function options.filter works fine', function(done) {
    const app = new Koa();
    app.use(staticCache({
      dir: path.join(__dirname, '..'),
      filter(file: string) { return file.indexOf('index.js') === 0; },
    }));
    const server = app.listen();
    request(server)
      .get('/Makefile')
      .expect(404, done);
  });

  it('should options.dynamic and options.preload works fine', function(done) {
    const app = new Koa();
    const files: Record<string, any> = {};
    app.use(staticCache({
      dir: path.join(__dirname, '..'),
      preload: false,
      dynamic: true,
      files,
    }));
    assert.deepEqual(files, {});
    request(app.listen())
      .get('/package.json')
      .expect(200, function(err, res) {
        assert(!err);
        assert(files['/package.json']);
        assert(res.headers['content-length']);
        assert(res.headers['last-modified']);
        assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
        done();
      });
  });

  it('should options.alias and options.preload works fine', function(done) {
    const app = new Koa();
    const files: Record<string, any> = {};
    app.use(staticCache({
      dir: path.join(__dirname, '..'),
      preload: false,
      dynamic: true,
      alias: {
        '/package': '/package.json',
      },
      files,
    }));
    assert.deepEqual(files, {});
    request(app.listen())
      .get('/package')
      .expect(200, function(err, res) {
        if (err) return done(err);
        assert(!err);
        assert(files['/package.json']);
        assert(!files['/package']);
        assert(res.headers['content-length']);

        request(app.listen())
          .get('/package.json')
          .expect(200, function(err, res) {
            if (err) return done(err);
            assert(!err);
            assert(files['/package.json']);
            assert(Object.keys(files).length === 1);
            assert(res.headers['content-length']);
            done();
          });
      });
  });

  it('should loadFile under options.dir', function(done) {
    const app = new Koa();
    app.use(staticCache({
      dir: __dirname,
      preload: false,
      dynamic: true,
    }));
    request(app.listen())
      .get('/%2E%2E/package.json')
      .expect(404)
      .end(done);
  });
});
