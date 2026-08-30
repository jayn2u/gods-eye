import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir:'e2e', use:{baseURL:'http://127.0.0.1:5173'},
  webServer:[
    {command:'GODS_EYE_USE_FIXTURES=1 uv run uvicorn gods_eye.app:app --app-dir ../service --host 127.0.0.1 --port 8000',port:8000,reuseExistingServer:true},
    {command:'pnpm dev',port:5173,reuseExistingServer:true},
  ]
})
