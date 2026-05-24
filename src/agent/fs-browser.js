'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const MAX_PATH_LENGTH = 2048;
async function listLocations(inputPath) {
    const targetPath = resolveTargetPath(inputPath);
    const stats = await fs.stat(targetPath);
    if (!stats.isDirectory()) {
        throw new Error('Path is not a directory');
    }
    const dirents = await fs.readdir(targetPath, { withFileTypes: true });
    const entries = [];
    for (const dirent of dirents) {
        if (dirent.isDirectory()) {
            entries.push({ name: dirent.name, path: path.join(targetPath, dirent.name), type: 'directory' });
        }
        else if (dirent.isFile()) {
            let size = 0;
            try {
                const st = await fs.stat(path.join(targetPath, dirent.name));
                size = st.size;
            }
            catch { }
            entries.push({ name: dirent.name, path: path.join(targetPath, dirent.name), type: 'file', size });
        }
    }
    entries.sort((a, b) => {
        if (a.type !== b.type)
            return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return {
        path: targetPath,
        parent: parentOf(targetPath),
        roots: roots(),
        entries,
    };
}
function resolveTargetPath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string')
        return os.homedir();
    if (inputPath.length > MAX_PATH_LENGTH)
        throw new Error('Path is too long');
    return path.resolve(inputPath);
}
function parentOf(targetPath) {
    const parsed = path.parse(targetPath);
    if (targetPath === parsed.root)
        return null;
    return path.dirname(targetPath);
}
function roots() {
    const home = os.homedir();
    if (process.platform !== 'win32') {
        return [
            { name: 'Home', path: home },
            { name: '/', path: '/' },
        ];
    }
    const drives = [];
    for (let code = 65; code <= 90; code++) {
        const drive = String.fromCharCode(code) + ':\\';
        try {
            if (fsSync.existsSync(drive))
                drives.push({ name: drive, path: drive });
        }
        catch { }
    }
    if (!drives.some((drive) => drive.path.toLowerCase() === home.slice(0, 3).toLowerCase())) {
        drives.unshift({ name: 'Home', path: home });
    }
    return drives;
}
module.exports = { listLocations };
