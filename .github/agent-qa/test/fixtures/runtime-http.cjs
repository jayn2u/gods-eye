'use strict'

const http = require('node:http')

const port = Number(process.argv[2])
const payload = JSON.parse(process.argv[3])
const server = http.createServer((_request, response) => {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(payload))
})
server.listen(port, '127.0.0.1', () => process.stdout.write(`${process.pid}\n`))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
