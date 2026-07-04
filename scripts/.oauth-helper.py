import pty, os, sys, time, select, json

fifo_path = sys.argv[1]
url_path  = sys.argv[2]

pid, fd = pty.fork()
if pid == 0:
    os.execvp("openclaw", ["openclaw", "models", "auth", "login", "--provider", "openai"])
else:
    output = b""
    oauth_url = None
    sent = False
    done = False

    try:
        while True:
            r, w, e = select.select([fd], [], [], 0.5)
            if r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                output += data
                text = output.decode("utf-8", errors="replace")

                # Extract OAuth URL (first time we see it)
                if oauth_url is None:
                    import re as rem
                    m = rem.search(r'https://auth\.openai\.com/oauth/authorize\?[^\s\n]+', text)
                    if m:
                        oauth_url = m.group(0)
                        with open(url_path, "w") as f:
                            f.write(oauth_url + "\n")

                # Wait for paste prompt, then read from fifo
                if not sent and ("paste the redirect URL" in text or "redirect URL" in text):
                    sent = True
                    # Open fifo (blocks until writer connects)
                    with open(fifo_path, "r") as fifo:
                        line = fifo.readline().strip()
                    if line:
                        os.write(fd, (line + "\n").encode())
                        done = True
            elif done:
                # After sending, keep reading briefly for completion output
                time.sleep(1)
                try:
                    while True:
                        r2, w2, e2 = select.select([fd], [], [], 0.3)
                        if not r2:
                            break
                        d2 = os.read(fd, 65536)
                        if not d2:
                            break
                        output += d2
                except OSError:
                    pass
                break
            elif oauth_url and not sent:
                # Still waiting — brief pause
                time.sleep(0.1)
    finally:
        os.close(fd)
        os.waitpid(pid, 0)

    # Write result
    result_text = output.decode("utf-8", errors="replace")
    import re as rem
    result_text = rem.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', result_text)
    result_text = rem.sub(r'\x1b\].*?\x1b\\\\', '', result_text)
    with open(url_path + ".result", "w") as f:
        f.write(result_text)
