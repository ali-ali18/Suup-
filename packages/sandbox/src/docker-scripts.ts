/**
 * Shell scripts that run INSIDE the container (POSIX sh, GNU coreutils/findutils).
 *
 * Each script is a constant: nothing that comes from the model is ever spliced into it. Model
 * data (paths, the command, content) reaches the script as positional arguments (`$1`, `$2`, ...)
 * or on stdin, and the host spawns `docker` with an argv array, never through a shell.
 *
 * Exit codes below are private to the file operations (no user command runs there).
 */
export const EXIT_ESCAPE = 42;
export const EXIT_NOT_FOUND = 44;
export const EXIT_IS_DIR = 45;
export const EXIT_MKDIR_FAILED = 46;
export const EXIT_NOT_DIR = 47;
/** `exec` wrapper only: the working directory leaves the workspace. Paired with a stderr marker. */
export const EXIT_EXEC_ESCAPE = 199;
export const EXEC_ESCAPE_MARKER = "suup: working directory escapes the workspace";

/**
 * argv: `sh -c SCRIPT sh PIDFILE SECONDS ROOT CWD COMMAND`
 *
 * Checks that the working directory, with symlinks resolved, is inside the workspace, then runs
 * the command under coreutils `timeout -s KILL`. `timeout` puts itself in its own process group
 * and, when the limit is hit, SIGKILLs the command AND its whole group, so a `sleep` started by
 * the command dies with it. The shell stays alive as a parent (no `exec`) so it can delete the
 * pid file afterwards. The pid file lets the host kill the tree if the host-side `docker exec`
 * client is aborted (see KILL_SCRIPT).
 */
export const EXEC_SCRIPT = `
pidfile=$1; secs=$2; root=$3; cwd=$4; cmd=$5
echo $$ > "$pidfile"
real=$(realpath -m -- "$cwd") && rroot=$(realpath -- "$root") || {
  echo "suup: cannot resolve the working directory" >&2; rm -f "$pidfile"; exit 1; }
case "$real" in
  "$rroot"|"$rroot"/*) ;;
  *) echo "${EXEC_ESCAPE_MARKER}" >&2; rm -f "$pidfile"; exit ${EXIT_EXEC_ESCAPE};;
esac
if [ ! -d "$real" ]; then
  echo "suup: working directory not found: $cwd" >&2; rm -f "$pidfile"; exit 1
fi
cd -- "$real" || { rm -f "$pidfile"; exit 1; }
timeout -s KILL "$secs" sh -c "$cmd"
rc=$?
rm -f "$pidfile"
exit "$rc"
`;

/**
 * argv: `sh -c SCRIPT sh PIDFILE`
 *
 * Kills the process tree rooted at the pid stored by EXEC_SCRIPT: each process is first stopped
 * (so it cannot fork more children while we walk), then its children are handled, then it is
 * killed. Waits up to 2 s for the pid file, in case the abort raced the start of the command.
 */
export const KILL_SCRIPT = `
pidfile=$1
i=0
while [ ! -s "$pidfile" ] && [ "$i" -lt 20 ]; do sleep 0.1; i=$((i+1)); done
pid=$(cat "$pidfile" 2>/dev/null) || exit 0
[ -n "$pid" ] || exit 0
kill_tree() {
  kill -STOP "$1" 2>/dev/null
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done
  kill -KILL "$1" 2>/dev/null
}
kill_tree "$pid"
rm -f "$pidfile"
`;

/** Common start of the file scripts: `$1` is the workspace root, `$2` the absolute target path. */
const FILE_PRELUDE = `
root=$1; p=$2
real=$(realpath -m -- "$p") || { echo "suup: cannot resolve path: $p" >&2; exit 70; }
rroot=$(realpath -- "$root") || { echo "suup: workspace root missing: $root" >&2; exit 70; }
case "$real" in
  "$rroot"|"$rroot"/*) ;;
  *) echo "suup: path escapes the workspace: $p" >&2; exit ${EXIT_ESCAPE};;
esac
`;

export const READ_SCRIPT = `${FILE_PRELUDE}
[ -e "$real" ] || { echo "ENOENT: no such file: $p" >&2; exit ${EXIT_NOT_FOUND}; }
[ -d "$real" ] && { echo "EISDIR: is a directory: $p" >&2; exit ${EXIT_IS_DIR}; }
exec cat -- "$real"
`;

/** Content arrives on stdin. */
export const WRITE_SCRIPT = `${FILE_PRELUDE}
[ -d "$real" ] && { echo "EISDIR: is a directory: $p" >&2; exit ${EXIT_IS_DIR}; }
mkdir -p -- "$(dirname -- "$real")" || exit ${EXIT_MKDIR_FAILED}
exec cat > "$real"
`;

/** Prints NUL-separated pairs: type of the target (\`d\`, \`f\`, ...), then the entry name. */
export const LIST_SCRIPT = `${FILE_PRELUDE}
[ -e "$real" ] || { echo "ENOENT: no such directory: $p" >&2; exit ${EXIT_NOT_FOUND}; }
[ -d "$real" ] || { echo "ENOTDIR: not a directory: $p" >&2; exit ${EXIT_NOT_DIR}; }
cd -- "$real" || exit 1
exec find . -mindepth 1 -maxdepth 1 -printf '%Y\\0%f\\0'
`;

/** Prints \`<file type>|<size>\`. */
export const STAT_SCRIPT = `${FILE_PRELUDE}
[ -e "$real" ] || exit ${EXIT_NOT_FOUND}
exec stat -c '%F|%s' -- "$real"
`;
