#!/bin/sh
cd /app/client && npm run dev &
cd /app && node app.js
