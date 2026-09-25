// Git exports GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and their siblings to every command it starts:
// a hook, `git rebase --exec`, a `git -c alias`. A test run started from there would hand them to
// every fixture's own `git` call, and the fixtures would then init, commit and push into the
// repository that runs the tests instead of their temp directories (#284: it turned this
// repository bare and pushed eleven fixture commits onto master). So no test sees them.
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
  delete process.env[key];
}
