// Import constraints and temporary contention do not establish broken storage.
function isFatalStorageError(error) {
    const code = String(error?.code || '');
    return /^SQLITE_(FULL|IOERR|CORRUPT|NOTADB|CANTOPEN|READONLY|PERM|AUTH)(?:_|$)/.test(code)
        || /^(EACCES|EPERM|ENOSPC|EDQUOT|EROFS|EIO|ENOENT)$/.test(code);
}

module.exports = { isFatalStorageError };
