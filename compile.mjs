import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const contractPath = './contracts/StormPolicy.sol';
const source = fs.readFileSync(contractPath, 'utf8');

const input = {
  language: 'Solidity',
  sources: {
    'StormPolicy.sol': { content: source },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object'] },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors) {
  let hasError = false;
  for (const err of output.errors) {
    console.log(err.severity.toUpperCase() + ':', err.formattedMessage);
    if (err.severity === 'error') hasError = true;
  }
  if (hasError) process.exit(1);
}

const contract = output.contracts['StormPolicy.sol']['StormPolicy'];
fs.mkdirSync('./build', { recursive: true });
fs.writeFileSync('./build/StormPolicy.abi.json', JSON.stringify(contract.abi, null, 2));
fs.writeFileSync('./build/StormPolicy.bytecode.txt', contract.evm.bytecode.object);

console.log('Compiled OK.');
console.log('ABI entries:', contract.abi.length);
console.log('Bytecode length:', contract.evm.bytecode.object.length / 2, 'bytes');
