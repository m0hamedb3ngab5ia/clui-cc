// electron-builder afterPack hook: runs after packaging, before code signing.
// codesign fails with "resource fork, Finder information, or similar detritus not
// allowed" when bundle folders carry Finder metadata, which iCloud-synced folders
// (e.g. ~/Documents with Desktop & Documents sync) keep adding to .app folders.
const { execFileSync } = require('child_process')

exports.default = async function afterPack(context) {
  if (process.platform !== 'darwin') return
  execFileSync('xattr', ['-cr', context.appOutDir])
}
