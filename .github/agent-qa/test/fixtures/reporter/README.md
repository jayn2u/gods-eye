# Reporter fixtures

`api.json` is the trusted GitHub API surface used by the executable publisher driver. The tests
construct stored ZIP archives directly from bounded report data so malformed central-directory,
path, duplicate, symlink, and declared-size cases exercise the production ZIP parser.
