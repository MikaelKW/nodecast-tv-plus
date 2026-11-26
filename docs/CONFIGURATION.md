# Configuration loading

The standard `npm start`, `npm run dev` and container commands load configuration through the same server entrypoint. It reads an optional `.env` file from the working directory before initializing authentication and the rest of the application.

By default, values already supplied in the process environment take precedence over values in `.env`, including explicitly empty values. A missing `.env` file is normal when the deployment platform supplies configuration directly. Production authentication still requires valid deployment secrets.

Docker Compose uses its `.env` file for variable substitution. Docker's `--env-file` option also supplies environment variables before NodeCast starts. Those files are read by Docker tooling, not by dotenv inside the container. Existing documented deployments do not need a new startup command for this dependency update.

## Custom dotenv configuration

The dotenv 18 update has compatibility differences for installations that customize the configuration loader:

- Encrypted `.env.vault` loading is no longer supported by dotenv. Such deployments need to supply configuration through the process environment or a protected plain `.env` file instead. Deployment secrets and the existing `/app/data` backup remain necessary.
- The ordinary `dotenv/config` preload continues to work, but legacy arguments such as `dotenv_config_path=...` are no longer read by that preload. A custom file path can be supplied through `DOTENV_CONFIG_PATH` or `DOTENV_PATH` instead.
- Direct `dotenv.config()` calls now honor those path variables and the override variables `DOTENV_CONFIG_OVERRIDE` and `DOTENV_OVERRIDE`. An explicitly enabled override permits file values to replace existing environment values. Leaving override unset preserves the normal environment-over-file precedence. Existing custom dotenv variables should be reviewed before upgrading.
- Informational dotenv loading messages now go to standard error rather than standard output. These messages do not, by themselves, indicate a failed application startup. `DOTENV_CONFIG_QUIET=true` suppresses them.

The application does not enable dotenv's optional fast parser or switch to its new CLI. Its default startup and configuration model remain unchanged.

Configuration files can contain deployment secrets. They remain outside the image and repository and should be protected and backed up with the deployment configuration. This dependency update does not introduce a database migration.
