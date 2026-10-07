const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let checkedCount = 0;
let errors = 0;

function walk(dir) {
  for (const item of fs.readdirSync(dir)) {
    if (item === 'node_modules' || item === '.git') continue;
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath);
    } else if (item.endsWith('.js')) {
      checkedCount++;
      try {
        execFileSync(process.execPath, ['--check', fullPath], { stdio: 'pipe' });
      } catch (err) {
        console.error(`Syntax check failed: ${path.relative(ROOT, fullPath)}`);
        errors++;
      }
    }
  }
}

walk(ROOT);
if (errors === 0) {
  console.log(`PASS: All ${checkedCount} JavaScript files passed node --check`);
  process.exit(0);
} else {
  console.error(`FAIL: ${errors} files failed node --check`);
  process.exit(1);
}
