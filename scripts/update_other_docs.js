const fs = require('fs');
const path = require('path');

// One-off PostgreSQL -> MongoDB doc sweep left over from commit 538cc50, already
// applied. Its unconditional s/PostgreSQL/MongoDB/g would also rewrite the
// deliberate annotations in ARCHITECTURE.md, DEPLOYMENT.md and
// DISASTER_RECOVERY.md, turning "no PostgreSQL in this deployment" into a false
// claim, so it now refuses to run unless forced.
if (process.env.RUN_ONE_OFF !== '1') {
  console.error(
    'scripts/update_other_docs.js is a completed one-off migration and will not run.\n' +
      'Set RUN_ONE_OFF=1 only if you mean to re-apply the blanket replacement.'
  );
  process.exit(1);
}

const dir = path.join(__dirname, '..');

function replaceInFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;

    content = content.replace(/PostgreSQL 16/g, 'MongoDB 7.0');
    content = content.replace(/PostgreSQL/g, 'MongoDB');
    content = content.replace(/postgres:5432/g, 'mongo:27017');
    content = content.replace(/postgresql:\/\//g, 'mongodb://');

    if (content !== original) {
        fs.writeFileSync(filePath, content);
        console.log(`Updated ${filePath}`);
    }
}

replaceInFile(path.join(dir, 'README.md'));
replaceInFile(path.join(dir, 'docs/ARCHITECTURE.md'));
replaceInFile(path.join(dir, 'docs/GETTING_STARTED.md'));
replaceInFile(path.join(dir, 'docs/DEPLOYMENT.md'));
replaceInFile(path.join(dir, 'docs/DISASTER_RECOVERY.md'));
replaceInFile(path.join(dir, '.env.example'));

// Wait, some specific replacements in README might be needed

