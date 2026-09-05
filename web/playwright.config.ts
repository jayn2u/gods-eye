import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir:'e2e', projects:[{name:'chromium',use:{browserName:'chromium'}}], use:{baseURL:'http://127.0.0.1:15173'},
  webServer: process.env.GODS_EYE_EXTERNAL_SERVERS === '1' ? undefined : [
    {command:'GODS_EYE_USE_FIXTURES=1 ../.venv/bin/uvicorn gods_eye.app:app --app-dir ../service --host 127.0.0.1 --port 8000',url:'http://127.0.0.1:8000/api/health',reuseExistingServer:true},
    {command:'corepack pnpm dev --port 15173',url:'http://127.0.0.1:15173',reuseExistingServer:true},
  ]
})
