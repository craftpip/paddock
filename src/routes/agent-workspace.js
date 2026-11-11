/**
 * One PAD's workspace files: browse, read, save, upload, move, download.
 */
const fs = require('fs');
const path = require('path');
const registry = require('../services/agent-registry');

/** Register this area's routes on the app. `ctx` carries the helpers app.js owns. */
module.exports = function register(app, ctx) {

  app.get('/api/agents/:name/workspace', async (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const relativePath = req.query.path || '/';
    const scope = req.query.scope || 'host';
    try {
      const listing = await require('../services/workspace').listDir(agent.name, relativePath, scope);
      res.json(listing);
    } catch (err) {
      const status = err.message === 'Container is not running' ? 503 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  app.get('/api/agents/:name/workspace/parent', (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    try {
      const listing = require('../services/workspace').listParentDir(agent.name, req.query.subpath || '');
      res.json(listing);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/agents/:name/workspace/parent/file', (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!req.query.path) return res.status(400).json({ error: 'path required' });
    try {
      const file = require('../services/workspace').readParentFile(agent.name, req.query.path);
      res.json(file);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  app.get('/api/agents/:name/workspace/parent/download', (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const relativePath = req.query.path;
    if (!relativePath) return res.status(400).send('path required');
    try {
      const absPath = require('../services/workspace').downloadParentFile(agent.name, relativePath);
      if (!fs.existsSync(absPath)) return res.status(404).send('Not found');
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) return res.status(400).send('Cannot download directory');
      if (stat.size > 50 * 1024 * 1024) return res.status(413).send('File too large');
      res.download(absPath);
    } catch (err) {
      res.status(400).send(err.message);
    }
  });

  app.get('/api/agents/:name/workspace/file', async (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!req.query.path) return res.status(400).json({ error: 'path required' });
    try {
      const file = await require('../services/workspace').readFile(agent.name, req.query.path, req.query.scope || 'host');
      res.json(file);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  app.post('/api/agents/:name/workspace/save', async (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    try {
      const result = await require('../services/workspace').writeFile(agent.name, filePath, content || '', req.body.scope || 'host');
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agents/:name/workspace/parent/save', (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    try {
      const result = require('../services/workspace').writeParentFile(agent.name, filePath, content || '');
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agents/:name/workspace/folder', async (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { path: parentPath, name: folderName } = req.body;
    try {
      await require('../services/workspace').createFolder(agent.name, parentPath, folderName, req.body.scope || 'host');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/agents/:name/workspace/rename', async (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { path: entryPath, new_name } = req.body;
    try {
      await require('../services/workspace').renameEntry(agent.name, entryPath, new_name, req.body.scope || 'host');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/agents/:name/workspace/delete', async (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { path: entryPath } = req.body;
    try {
      await require('../services/workspace').deleteEntry(agent.name, entryPath, req.body.scope || 'host');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/agents/:name/workspace/move', async (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { path: fromPath, to } = req.body;
    try {
      await require('../services/workspace').moveEntry(agent.name, fromPath, to, req.body.scope || 'host');
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/agents/:name/workspace/upload', (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const multer = require('multer');
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
    upload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const targetDir = req.body.path || '/';
      const scope = req.body.scope || 'host';
      try {
        await require('../services/workspace').writeFileB64(agent.name, targetDir, req.file.originalname, req.file.buffer, scope);
        res.json({ ok: true, name: path.basename(req.file.originalname) });
      } catch (e2) {
        res.status(500).json({ error: e2.message });
      }
    });
  });

  app.post('/api/agents/:name/workspace/upload-multiple', (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const multer = require('multer');
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: require('../services/workspace').MAX_UPLOAD_SIZE },
    });
    upload.array('files', 2000)(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
      const targetDir = req.body.path || '/';
      const scope = req.body.scope || 'host';
      const ws = require('../services/workspace');
      const relPaths = Array.isArray(req.body.paths) ? req.body.paths : (req.body.paths ? [req.body.paths] : []);
      try {
        let uploaded = 0;
        for (let i = 0; i < req.files.length; i++) {
          const file = req.files[i];
          const rel = String(relPaths[i] || file.originalname || '').replace(/\\/g, '/');
          const safeName = path.posix.basename(rel);
          if (!safeName || safeName.startsWith('.') || rel.split('/').includes('..')) continue;
          const sub = path.posix.dirname(rel);
          const destDir = sub === '.' ? targetDir : path.posix.join(targetDir, sub);
          await ws.createDirectories(agent.name, destDir, scope);
          await ws.writeFileB64(agent.name, destDir, safeName, file.buffer, scope);
          uploaded++;
        }
        res.json({ ok: true, uploaded });
      } catch (e2) {
        res.status(500).json({ error: e2.message });
      }
    });
  });

  app.post('/api/agents/:name/workspace/create-file', async (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const { path: relativePath, name: fileName } = req.body;
    if (!fileName) return res.status(400).json({ error: 'File name required' });
    try {
      const dir = relativePath || '/';
      const filePath = dir === '/' ? '/' + fileName : dir + '/' + fileName;
      await require('../services/workspace').writeFile(agent.name, filePath, '', req.body.scope || 'host');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/agents/:name/workspace/media', async (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const relativePath = req.query.path;
    if (!relativePath) return res.status(400).send('path required');
    const MEDIA_MIME = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
      mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
    };
    try {
      const file = await require('../services/workspace').readFileB64(agent.name, relativePath, req.query.scope || 'host');
      if (file.error) return res.status(404).send(file.error);
      if (file.size > 100 * 1024 * 1024) return res.status(413).send('File too large');
      const ext = (file.name || '').split('.').pop().toLowerCase();
      const mime = MEDIA_MIME[ext];
      if (!mime) return res.status(415).send('Unsupported media type');
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name || 'media')}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(Buffer.from(file.content, 'base64'));
    } catch (err) {
      res.status(400).send(err.message);
    }
  });

  app.get('/api/agents/:name/workspace/download', async (req, res) => {
    const agent = registry.getAgent(req.params.name);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const relativePath = req.query.path;
    if (!relativePath) return res.status(400).send('path required');
    try {
      const file = await require('../services/workspace').readFileB64(agent.name, relativePath, req.query.scope || 'host');
      if (file.error) return res.status(404).send(file.error);
      if (file.size > 50 * 1024 * 1024) return res.status(413).send('File too large');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name || 'download')}"`);
      res.send(Buffer.from(file.content, 'base64'));
    } catch (err) {
      res.status(400).send(err.message);
    }
  });
};
