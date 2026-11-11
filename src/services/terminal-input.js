const MIN_COLS = 40;
const MIN_ROWS = 8;
// A WebSocket opens before the asynchronous tmux/PTY setup finishes. Listen
// immediately: retain the latest layout size, but never queue shell input.
function createTerminalInput({ cols, rows }) {
  let size = { cols, rows };
  let revision = 0;
  let exec = null;
  let stream = null;
  let ready = false;
  let closed = false;

  function onMessage(data) {
    if (closed) return;
    const msg = data.toString();
    if (msg.charCodeAt(0) === 0 && msg.charCodeAt(1) === 0) {
      try {
        const parsed = JSON.parse(msg.slice(2));
        if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          const w = Math.max(2, parseInt(parsed.cols, 10) || 0);
          const h = Math.max(2, parseInt(parsed.rows, 10) || 0);
          // A terminal squeezed to a few cells (Mission with the queue panel
          // over it) must not shrink the PAD pane: a 10x6 agent TUI cannot draw
          // its UI and the runner cannot see it become ready. Ignore the frame;
          // the control frame is still consumed, never typed into the shell.
          if (w < MIN_COLS || h < MIN_ROWS) return;
          size = { cols: w, rows: h };
          revision += 1;
          if (ready) exec.resize({ h, w }).catch(() => {});
        }
      } catch {}
      return;
    }
    if (ready && stream && !stream.destroyed) stream.write(data);
  }

  async function attach(ptyExec, ptyStream) {
    exec = ptyExec;
    stream = ptyStream;
    // Layout can change during Docker's resize round-trip too. Finish with
    // the latest size before telling the browser its commands can run.
    let applied;
    do {
      applied = revision;
      const { cols: w, rows: h } = size;
      await exec.resize({ h, w });
    } while (!closed && applied !== revision);
    ready = !closed && !stream.destroyed;
    return ready;
  }

  return {
    onMessage,
    attach,
    get size() { return size; },
    close() { closed = true; ready = false; stream = null; exec = null; },
  };
}

module.exports = { createTerminalInput };
