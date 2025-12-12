import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import SSHConfig from 'ssh-config';
import type { SSHTunnelConfig } from '../types/ssh.js';

/**
 * Default SSH key paths to check if no IdentityFile is specified
 */
const DEFAULT_SSH_KEYS = [
  '~/.ssh/id_rsa',
  '~/.ssh/id_ed25519',
  '~/.ssh/id_ecdsa',
  '~/.ssh/id_dsa'
];

/**
 * Expand tilde (~) in file paths to home directory
 */
function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return join(homedir(), filePath.substring(2));
  }
  return filePath;
}

/**
 * Check if a file exists
 */
function fileExists(filePath: string): boolean {
  try {
    return existsSync(expandTilde(filePath));
  } catch {
    return false;
  }
}

/**
 * Find the first existing SSH key from default locations
 */
function findDefaultSSHKey(): string | undefined {
  for (const keyPath of DEFAULT_SSH_KEYS) {
    if (fileExists(keyPath)) {
      return expandTilde(keyPath);
    }
  }
  return undefined;
}

/**
 * Parse SSH config file and extract configuration for a specific host
 * @param hostAlias The host alias to look up in the SSH config
 * @param configPath Path to SSH config file
 * @returns SSH tunnel configuration or null if not found
 */
export function parseSSHConfig(
  hostAlias: string,
  configPath: string
): SSHTunnelConfig | null {
  const sshConfigPath = configPath;

  // Check if SSH config file exists
  if (!existsSync(sshConfigPath)) {
    return null;
  }

  try {
    // Read and parse SSH config file
    const configContent = readFileSync(sshConfigPath, 'utf8');
    const config = SSHConfig.parse(configContent);

    // Find configuration for the specified host
    const hostConfig = config.compute(hostAlias);
    
    // Check if we have a valid config (not just Include directives)
    if (!hostConfig || !hostConfig.HostName && !hostConfig.User) {
      return null;
    }

    // Extract SSH configuration parameters
    const sshConfig: Partial<SSHTunnelConfig> = {};

    // Helper to extract first value from string | string[]
    const getFirstValue = (value: string | string[] | undefined): string | undefined => {
      if (value === undefined) return undefined;
      return Array.isArray(value) ? value[0] : value;
    };

    // Host (required)
    const hostName = getFirstValue(hostConfig.HostName);
    if (hostName) {
      sshConfig.host = hostName;
    } else {
      // If no HostName specified, use the host alias itself
      sshConfig.host = hostAlias;
    }

    // Port (optional, default will be 22)
    const port = getFirstValue(hostConfig.Port);
    if (port) {
      sshConfig.port = parseInt(port, 10);
    }

    // User (required)
    const user = getFirstValue(hostConfig.User);
    if (user) {
      sshConfig.username = user;
    }

    // IdentityFile (private key)
    if (hostConfig.IdentityFile) {
      // SSH config can have multiple IdentityFile entries, take the first one
      const identityFile = Array.isArray(hostConfig.IdentityFile) 
        ? hostConfig.IdentityFile[0] 
        : hostConfig.IdentityFile;
      
      const expandedPath = expandTilde(identityFile);
      if (fileExists(expandedPath)) {
        sshConfig.privateKey = expandedPath;
      }
    }

    // If no IdentityFile specified or found, try default SSH keys
    if (!sshConfig.privateKey) {
      const defaultKey = findDefaultSSHKey();
      if (defaultKey) {
        sshConfig.privateKey = defaultKey;
      }
    }

    // ProxyJump support could be added in the future if needed
    // Currently, we'll log a warning if ProxyJump is detected
    if (hostConfig.ProxyJump || hostConfig.ProxyCommand) {
      console.error('Warning: ProxyJump/ProxyCommand in SSH config is not yet supported by DBHub');
    }

    // Validate that we have minimum required fields
    if (!sshConfig.host || !sshConfig.username) {
      return null;
    }

    return sshConfig as SSHTunnelConfig;
  } catch (error) {
    console.error(`Error parsing SSH config: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Check if a string looks like an SSH host alias (not an IP or domain)
 * This is a heuristic to determine if we should look up the host in SSH config
 */
export function looksLikeSSHAlias(host: string): boolean {
  // If it contains dots, it's likely a domain or IP
  if (host.includes('.')) {
    return false;
  }
  
  // If it's all numbers (with possible colons for IPv6), it's likely an IP
  if (/^[\d:]+$/.test(host)) {
    return false;
  }
  
  // Check for IPv6 addresses with hex characters
  if (/^[0-9a-fA-F:]+$/.test(host) && host.includes(':')) {
    return false;
  }
  
  // Otherwise, treat it as a potential SSH alias
  return true;
}