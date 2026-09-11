'use strict';

const fs = require('fs');
const path = require('path');

const scriptsDir = path.join(__dirname, '..', 'scripts');

describe('userscript frame isolation', () => {
  test.each(['douyin.user.js', '_template.user.js'])(
    '%s runs only in the top-level page',
    (filename) => {
      const source = fs.readFileSync(path.join(scriptsDir, filename), 'utf8');

      expect(source).toMatch(/^\/\/ @noframes\s*$/m);
      expect(source).toContain('if (window.top !== window.self) return;');
    },
  );
});
