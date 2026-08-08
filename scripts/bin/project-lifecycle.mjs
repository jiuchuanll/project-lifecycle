#!/usr/bin/env node

const version = '0.1.0';
const command = process.argv[2] ?? 'help';

if (command === 'help') {
  console.log(`Project Lifecycle ${version}

Commands:
  validate-json
  validate-pair
  parse-facts
  validate-fixtures`);
} else if (command === 'version') {
  console.log(version);
} else {
  console.error(`CLI_UNKNOWN_COMMAND: ${command}`);
  process.exitCode = 2;
}
