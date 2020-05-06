import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import dns from 'dns';
import url from 'url';
import os from 'os';
import spawn from 'cross-spawn';
import semver from 'semver';
import chalk from 'chalk';
import validateProjectName from 'validate-npm-package-name';

interface PackageJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

interface Config {
  name: string;
  verbose: boolean;
  type: string;
  language: string;
  useNpm: boolean;
  usePnp: boolean;
  appType: string;
  checkAppNames: string[];
  templatePackageName: string;
}

export function generateProject({
  name,
  type,
  language,
  useNpm,
  usePnp,
  verbose,
  appType,
  checkAppNames,
  templatePackageName,
}: Config) {
  const template = `${type}/${language}`;
  const useTypeScript = language === 'typescript';
  checkNodeVersion(useTypeScript);
  const root = path.resolve(name);
  const appName = path.basename(root);
  checkAppName(appName, checkAppNames);
  fs.ensureDirSync(name);
  if (!isSafeToCreateProjectIn(root, name)) {
    process.exit(1);
  }
  console.log();

  console.log(`Creating a new ${appType} app in ${chalk.green(root)}.`);
  console.log();

  const packageJson = {
    name: appName,
    version: '0.0.1',
    private: true,
  };
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(packageJson, null, 2) + os.EOL
  );

  const useYarn = useNpm ? false : shouldUseYarn();
  const originalDirectory = process.cwd();
  process.chdir(root);
  if (!useYarn && !checkThatNpmCanReadCwd()) {
    process.exit(1);
  }

  if (!useYarn) {
    const npmInfo = checkNpmVersion();
    if (!npmInfo.hasMinNpm) {
      if (npmInfo.npmVersion) {
        console.log(
          chalk.yellow(
            `You are using npm ${npmInfo.npmVersion} so the project will be bootstrapped with an old unsupported version of tools.\n\n` +
              `Please update to npm 5 or higher.\n`
          )
        );
      }
    }
  } else if (usePnp) {
    const yarnInfo = checkYarnVersion();
    if (!yarnInfo.hasMinYarnPnp) {
      if (yarnInfo.yarnVersion) {
        console.log(
          chalk.yellow(
            `You are using Yarn ${yarnInfo.yarnVersion} together with the --use-pnp flag, but Plug'n'Play is only supported starting from the 1.12 release.\n\n` +
              `Please update to Yarn 1.12 or higher.\n`
          )
        );
      }
      // 1.11 had an issue with webpack-dev-middleware, so better not use PnP with it (never reached stable, but still)
      usePnp = false;
    }
  }

  if (useYarn) {
    let yarnUsesDefaultRegistry = true;
    try {
      yarnUsesDefaultRegistry =
        execSync('yarn config get registry').toString().trim() ===
        'https://registry.yarnpkg.com';
    } catch (e) {
      // ignore
    }
    if (yarnUsesDefaultRegistry) {
      // TODO: copy `yarn.lock`?
    }
  }
  run(
    templatePackageName,
    root,
    appName,
    verbose,
    originalDirectory,
    template,
    useYarn,
    usePnp
  );
}

export async function run(
  templatePackageName: string,
  root: string,
  appName: string,
  verbose: boolean,
  originalDirectory: string,
  template: string,
  useYarn: boolean,
  usePnp: boolean,
) {
  try {
    const allDependencies = [templatePackageName];
    console.log('Installing packages. This might take a couple of minutes.');
    const isOnline = await checkIfOnline(useYarn);
    allDependencies.push(templatePackageName);

    console.log(`Installing ${chalk.cyan(templatePackageName)} ...`);
    console.log();

    await install(
      root,
      useYarn,
      usePnp,
      allDependencies,
      verbose,
      isOnline,
      true
    );

    const templateBasePath = path.resolve(
      `node_modules/${templatePackageName}/templates/${template}`
    );
    const templateDir = path.join(templateBasePath, `template`);
    const appPath = process.cwd();
    if (fs.existsSync(templateDir)) {
      fs.copySync(templateDir, appPath);
    } else {
      console.error(
        `Could not locate supplied template: ${chalk.green(templateDir)}`
      );
      return;
    }
    const gitignoreExists = fs.existsSync(path.join(appPath, '.gitignore'));
    if (gitignoreExists) {
      const data = fs.readFileSync(path.join(appPath, 'gitignore'));
      fs.appendFileSync(path.join(appPath, '.gitignore'), data);
      fs.unlinkSync(path.join(appPath, 'gitignore'));
    } else {
      fs.moveSync(
        path.join(appPath, 'gitignore'),
        path.join(appPath, '.gitignore')
      );
    }

    const appPackagePath = path.join(appPath, `package.json`);
    let appPackage: PackageJson = {};
    if (fs.existsSync(appPackagePath)) {
      appPackage = require(appPackagePath);
    } else {
      // TODO:
      console.error(
        `Template of 'package.json' does not exist: ${chalk.green(
          appPackagePath
        )}`
      );
      return;
    }

    const templateJsonPath = path.join(templateBasePath, `template.json`);
    let templateJson: PackageJson = {};
    if (fs.existsSync(templateJsonPath)) {
      templateJson = require(templateJsonPath);
    }
    if (templateJson.scripts) {
      Object.assign(appPackage, {
        scripts: templateJson.scripts,
      });
    }
    if (useYarn && appPackage.scripts) {
      appPackage.scripts = Object.entries(appPackage.scripts).reduce(
        (acc, [key, value]) => ({
          ...acc,
          [key]: value.replace(/(npm run |npm )/, 'yarn '),
        }),
        {}
      );
    }
    fs.writeFileSync(
      appPackagePath,
      JSON.stringify(appPackage, null, 2) + os.EOL
    );

    if (templateJson.devDependencies) {
      const dependencies = Object.entries(
        templateJson.devDependencies
      ).map(([name, version]) =>
        version === '*' ? name : `${name}@${version}`
      );
      await install(
        root,
        useYarn,
        usePnp,
        dependencies,
        verbose,
        isOnline,
        true
      );
    }

    if (templateJson.dependencies) {
      const dependencies = Object.entries(
        templateJson.dependencies
      ).map(([name, version]) =>
        version === '*' ? name : `${name}@${version}`
      );
      await install(
        root,
        useYarn,
        usePnp,
        dependencies,
        verbose,
        isOnline,
        false
      );
    }
    console.log();
    console.log(chalk.green('Created successfully.'));
    console.log();
    console.log(`Run the following command to start ${chalk.cyan(appName)} project:`);
    console.log();
    console.log(`  ${chalk.cyan(`cd ${appName}`)}`);
    console.log(`  ${chalk.cyan(`${useYarn? 'yarn': 'npm'} start`)}`);
    console.log();
  } catch (reason) {
    console.log();
    console.log('Aborting installation.');
    if (reason.command) {
      console.log(`  ${chalk.cyan(reason.command)} has failed.`);
    } else {
      console.log(chalk.red('Unexpected error. Please report it as a bug:'));
      console.log(reason);
    }
    console.log();

    // On 'exit' we will delete these files from target directory.
    const knownGeneratedFiles = ['package.json', 'yarn.lock', 'node_modules'];
    const currentFiles = fs.readdirSync(path.join(root));
    currentFiles.forEach((file) => {
      knownGeneratedFiles.forEach((fileToMatch) => {
        // This removes all knownGeneratedFiles.
        if (file === fileToMatch) {
          console.log(`Deleting generated file... ${chalk.cyan(file)}`);
          fs.removeSync(path.join(root, file));
        }
      });
    });
    const remainingFiles = fs.readdirSync(path.join(root));
    if (!remainingFiles.length) {
      // Delete target folder if empty
      console.log(
        `Deleting ${chalk.cyan(`${appName}/`)} from ${chalk.cyan(
          path.resolve(root, '..')
        )}`
      );
      process.chdir(path.resolve(root, '..'));
      fs.removeSync(path.join(root));
    }
    console.log('Done.');
    process.exit(1);
  }
}

export function checkNodeVersion(useTypeScript: boolean) {
  const unsupportedNodeVersion = !semver.satisfies(process.version, '>=8.10.0');
  if (unsupportedNodeVersion && useTypeScript) {
    console.error(
      chalk.red(
        `You are using Node ${process.version} with the TypeScript template. Node 8.10 or higher is required to use TypeScript.\n`
      )
    );

    process.exit(1);
  } else if (unsupportedNodeVersion) {
    console.log(
      chalk.yellow(
        `You are using Node ${process.version} so the project will be bootstrapped with an old unsupported version of tools.\n\n` +
          `Please update to Node 8.10 or higher.\n`
      )
    );
  }
}

export function checkAppName(appName: string, dependencies: string[]) {
  const validationResult = validateProjectName(appName);
  if (!validationResult.validForNewPackages) {
    console.error(
      chalk.red(
        `Cannot create a project named ${chalk.green(
          `"${appName}"`
        )} because of npm naming restrictions:\n`
      )
    );
    [
      ...(validationResult.errors || []),
      ...(validationResult.warnings || []),
    ].forEach((error) => {
      console.error(chalk.red(`  * ${error}`));
    });
    console.error(chalk.red('\nPlease choose a different project name.'));
    process.exit(1);
  }
  if (dependencies.includes(appName)) {
    console.error(
      chalk.red(
        `Cannot create a project named ${chalk.green(
          `"${appName}"`
        )} because a dependency with the same name exists.\n` +
          `Due to the way npm works, the following names are not allowed:\n\n`
      ) +
        chalk.cyan(dependencies.map((depName) => `  ${depName}`).join('\n')) +
        chalk.red('\n\nPlease choose a different project name.')
    );
    process.exit(1);
  }
}

export function isSafeToCreateProjectIn(root: string, name: string) {
  const validFiles = [
    '.DS_Store',
    '.git',
    '.gitattributes',
    '.gitignore',
    '.gitlab-ci.yml',
    '.hg',
    '.hgcheck',
    '.hgignore',
    '.idea',
    '.npmignore',
    '.travis.yml',
    'docs',
    'LICENSE',
    'README.md',
    'mkdocs.yml',
    'Thumbs.db',
  ];
  const errorLogFilePatterns = [
    'npm-debug.log',
    'yarn-error.log',
    'yarn-debug.log',
  ];
  const isErrorLog = (file: string) => {
    return errorLogFilePatterns.some((pattern) => file.startsWith(pattern));
  };

  const conflicts = fs
    .readdirSync(root)
    .filter((file) => !validFiles.includes(file))
    .filter((file) => !/\.iml$/.test(file))
    .filter((file) => !isErrorLog(file));

  if (conflicts.length > 0) {
    console.log(
      `The directory ${chalk.green(name)} contains files that could conflict:`
    );
    console.log();
    for (const file of conflicts) {
      try {
        const stats = fs.lstatSync(path.join(root, file));
        if (stats.isDirectory()) {
          console.log(`  ${chalk.blue(`${file}/`)}`);
        } else {
          console.log(`  ${file}`);
        }
      } catch (e) {
        console.log(`  ${file}`);
      }
    }
    console.log();
    console.log(
      'Either try using a new directory name, or remove the files listed above.'
    );

    return false;
  }
  fs.readdirSync(root).forEach((file) => {
    if (isErrorLog(file)) {
      fs.removeSync(path.join(root, file));
    }
  });
  return true;
}

export function shouldUseYarn() {
  try {
    execSync('yarn --version', { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

export function checkThatNpmCanReadCwd() {
  const cwd = process.cwd();
  let childOutput = null;
  try {
    childOutput = spawn.sync('npm', ['config', 'list']).output.join('');
  } catch (err) {
    return true;
  }
  if (typeof childOutput !== 'string') {
    return true;
  }
  const lines = childOutput.split('\n');
  const prefix = '; cwd = ';
  const line = lines.find((line) => line.startsWith(prefix));
  if (typeof line !== 'string') {
    return true;
  }
  const npmCWD = line.substring(prefix.length);
  if (npmCWD === cwd) {
    return true;
  }
  console.error(
    chalk.red(
      `Could not start an npm process in the right directory.\n\n` +
        `The current directory is: ${chalk.bold(cwd)}\n` +
        `However, a newly started npm process runs in: ${chalk.bold(
          npmCWD
        )}\n\n` +
        `This is probably caused by a misconfigured system terminal shell.`
    )
  );
  if (process.platform === 'win32') {
    console.error(
      chalk.red(`On Windows, this can usually be fixed by running:\n\n`) +
        `  ${chalk.cyan(
          'reg'
        )} delete "HKCU\\Software\\Microsoft\\Command Processor" /v AutoRun /f\n` +
        `  ${chalk.cyan(
          'reg'
        )} delete "HKLM\\Software\\Microsoft\\Command Processor" /v AutoRun /f\n\n` +
        chalk.red(`Try to run the above two lines in the terminal.\n`) +
        chalk.red(
          `To learn more about this problem, read: https://blogs.msdn.microsoft.com/oldnewthing/20071121-00/?p=24433/`
        )
    );
  }
  return false;
}

export function checkNpmVersion() {
  let hasMinNpm = false;
  let npmVersion = null;
  try {
    npmVersion = execSync('npm --version').toString().trim();
    hasMinNpm = semver.gte(npmVersion, '5.0.0');
  } catch (err) {
    // ignore
  }
  return {
    hasMinNpm: hasMinNpm,
    npmVersion: npmVersion,
  };
}

export function checkYarnVersion() {
  const minYarnPnp = '1.12.0';
  let hasMinYarnPnp = false;
  let yarnVersion = null;
  try {
    yarnVersion = execSync('yarn --version').toString().trim();
    if (semver.valid(yarnVersion)) {
      hasMinYarnPnp = semver.gte(yarnVersion, minYarnPnp);
    } else {
      const trimmedYarnVersionMatch = /^(.+?)[-+].+$/.exec(yarnVersion);
      if (trimmedYarnVersionMatch) {
        const trimmedYarnVersion = trimmedYarnVersionMatch.pop();
        hasMinYarnPnp = semver.gte(trimmedYarnVersion, minYarnPnp);
      }
    }
  } catch (err) {
    // ignore
  }
  return {
    hasMinYarnPnp: hasMinYarnPnp,
    yarnVersion: yarnVersion,
  };
}

function getProxy() {
  if (process.env.https_proxy) {
    return process.env.https_proxy;
  } else {
    try {
      // Trying to read https-proxy from .npmrc
      let httpsProxy = execSync('npm config get https-proxy').toString().trim();
      return httpsProxy !== 'null' ? httpsProxy : undefined;
    } catch (e) {
      return;
    }
  }
}

export function checkIfOnline(useYarn: boolean): Promise<boolean> {
  if (!useYarn) {
    // Don't ping the Yarn registry.
    // We'll just assume the best case.
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    dns.lookup('registry.yarnpkg.com', (err) => {
      let proxy;
      if (err != null && (proxy = getProxy())) {
        // If a proxy is defined, we likely can't resolve external hostnames.
        // Try to resolve the proxy name as an indication of a connection.
        dns.lookup(url.parse(proxy).hostname!, (proxyErr) => {
          resolve(proxyErr == null);
        });
      } else {
        resolve(err == null);
      }
    });
  });
}

export function install(
  root: string,
  useYarn: boolean,
  usePnp: boolean,
  dependencies: string[],
  verbose: boolean,
  isOnline: boolean,
  isDev: boolean
) {
  return new Promise((resolve, reject) => {
    let command: string;
    let args: string[];
    if (useYarn) {
      command = 'yarn';
      args = ['add', '--exact'];
      if (isDev) {
        args.push('--dev');
      }
      if (!isOnline) {
        args.push('--offline');
      }
      if (usePnp) {
        args.push('--enable-pnp');
      }
      [].push.apply(args, dependencies);

      args.push('--cwd');
      args.push(root);

      if (!isOnline) {
        console.log(chalk.yellow('You appear to be offline.'));
        console.log(chalk.yellow('Falling back to the local Yarn cache.'));
        console.log();
      }
    } else {
      command = 'npm';
      args = [
        'install',
        isDev ? '--save-dev' : '--save',
        '--save-exact',
        '--loglevel',
        'error',
      ].concat(dependencies);

      if (usePnp) {
        console.log(chalk.yellow("NPM doesn't support PnP."));
        console.log(chalk.yellow('Falling back to the regular installs.'));
        console.log();
      }
    }

    if (verbose) {
      args.push('--verbose');
    }

    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('close', (code: number) => {
      if (code !== 0) {
        reject({
          command: `${command} ${args.join(' ')}`,
        });
        return;
      }
      resolve();
    });
  });
}
