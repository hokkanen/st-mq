export const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ConnectionAttempts=1', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3', '-o', 'LogLevel=ERROR'];

export function sshOptions(configPath) { return configPath ? ['-F', configPath, ...SSH_OPTIONS] : [...SSH_OPTIONS]; }
