export const createFakeProcessRunner = (responses = []) => {
  const calls = [];
  let index = 0;
  return Object.freeze({
    calls,
    runProcess: async (command, args, options = {}) => {
      calls.push({ command, args: [...args], options: { ...options } });
      return responses[index++] ?? { ok: true, code: 0, stdout: '', stderr: '' };
    },
  });
};
