# Repository Agent Constraints

## No Concrete Environment Information

- Never add values tied to an actual developer machine, deployment, account, or network to documentation, source code, tests, examples, generated diagram sources or assets, scripts, configuration templates, or commit messages.
- Prohibited values include real hostnames, IP addresses, domains, user names, email addresses, machine names, personal or host-specific absolute paths, repository remotes, credentials, tokens, keys, cloud account identifiers, and private service endpoints.
- Supply deployment-specific values at runtime through environment variables, command-line arguments, or an approved secret store. In documentation and tests, use explicit placeholders such as `<repository-url>` or standards-reserved values such as `.test`, `.invalid`, and loopback addresses.
- Portable project contracts are not environment information. Stable service names, project-owned installation paths, loopback bindings, reserved test identifiers, and public upstream dependency URLs may be committed when they define reproducible behavior and were not copied from a real environment.
- Before committing, inspect every changed tracked file, including generated assets, and remove environment details from examples, logs, command output, fixtures, and metadata.

## Filing Information Deployment

- 部署到远程环境时，如果本地仓库中存在 `apps/web/filing/filing.config.json`，必须在部署前将该文件传输到远端仓库的 `apps/web/filing/filing.config.json`。
