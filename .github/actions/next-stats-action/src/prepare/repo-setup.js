const path = require('path')
const fs = require('fs-extra')
const exec = require('../util/exec')
const { remove } = require('fs-extra')
const logger = require('../util/logger')
const semver = require('semver')
const { trace } = require('next/trace')

module.exports = (actionInfo) => {
  return {
    async cloneRepo(repoPath = '', dest = '') {
      await remove(dest)
      await exec(`git clone ${actionInfo.gitRoot}${repoPath} ${dest}`)
    },
    async checkoutRef(ref = '', repoDir = '') {
      await exec(`cd ${repoDir} && git fetch && git checkout ${ref}`)
    },
    async getLastStable(repoDir = '', ref) {
      const { stdout } = await exec(`cd ${repoDir} && git tag -l`)
      const tags = stdout.trim().split('\n')
      let lastStableTag

      for (let i = tags.length - 1; i >= 0; i--) {
        const curTag = tags[i]
        // stable doesn't include `-canary` or `-beta`
        if (!curTag.includes('-') && !ref.includes(curTag)) {
          if (!lastStableTag || semver.gt(curTag, lastStableTag)) {
            lastStableTag = curTag
          }
        }
      }
      return lastStableTag
    },
    async getCommitId(repoDir = '') {
      const { stdout } = await exec(`cd ${repoDir} && git rev-parse HEAD`)
      return stdout.trim()
    },
    async resetToRef(ref = '', repoDir = '') {
      await exec(`cd ${repoDir} && git reset --hard ${ref}`)
    },
    async mergeBranch(ref = '', origRepoDir = '', destRepoDir = '') {
      await exec(`cd ${destRepoDir} && git remote add upstream ${origRepoDir}`)
      await exec(`cd ${destRepoDir} && git fetch upstream`)

      try {
        await exec(`cd ${destRepoDir} && git merge upstream/${ref}`)
        logger('Auto merge of main branch successful')
      } catch (err) {
        logger.error('Failed to auto merge main branch:', err)

        if (err.stdout && err.stdout.includes('CONFLICT')) {
          await exec(`cd ${destRepoDir} && git merge --abort`)
          logger('aborted auto merge')
        }
      }
    },
    async linkPackages({ repoDir = '', nextSwcPkg, parentSpan }) {
      const rootSpan = parentSpan
        ? parentSpan.traceChild('linkPackages')
        : trace('linkPachages')

      return await rootSpan.traceAsyncFn(async (rootSpan) => {
        const pkgPaths = new Map()
        const pkgDatas = new Map()
        let pkgs

        try {
          pkgs = await fs.readdir(path.join(repoDir, 'packages'))
        } catch (err) {
          if (err.code === 'ENOENT') {
            console.log('no packages to link')
            return pkgPaths
          }
          throw err
        }

        await rootSpan
          .traceChild('getting package data')
          .traceAsyncFn(async () => {
            for (const pkg of pkgs) {
              const pkgPath = path.join(repoDir, 'packages', pkg)
              const packedPkgPath = path.join(pkgPath, `${pkg}-packed.tgz`)

              const pkgDataPath = path.join(pkgPath, 'package.json')
              if (!fs.existsSync(pkgDataPath)) {
                console.log(`Skipping ${pkgDataPath}`)
                continue
              }
              const pkgData = require(pkgDataPath)
              const { name } = pkgData
              pkgDatas.set(name, {
                pkgDataPath,
                pkg,
                pkgPath,
                pkgData,
                packedPkgPath,
              })
              pkgPaths.set(name, packedPkgPath)
            }
          })

        await rootSpan
          .traceChild('writing package data')
          .traceAsyncFn(async () => {
            for (const pkg of pkgDatas.keys()) {
              const { pkgDataPath, pkgData } = pkgDatas.get(pkg)

              for (const pkg of pkgDatas.keys()) {
                const { packedPkgPath } = pkgDatas.get(pkg)
                if (!pkgData.dependencies || !pkgData.dependencies[pkg])
                  continue
                pkgData.dependencies[pkg] = packedPkgPath
              }
              // make sure native binaries are included in local linking
              if (pkg === '@next/swc') {
                if (!pkgData.files) {
                  pkgData.files = []
                }
                pkgData.files.push('native')
                console.log(
                  'using swc binaries: ',
                  await exec(
                    `ls ${path.join(path.dirname(pkgDataPath), 'native')}`
                  )
                )
              }
              if (pkg === 'next') {
                if (nextSwcPkg) {
                  Object.assign(pkgData.dependencies, nextSwcPkg)
                } else {
                  if (pkgDatas.get('@next/swc')) {
                    pkgData.dependencies['@next/swc'] =
                      pkgDatas.get('@next/swc').packedPkgPath
                  } else {
                    pkgData.files.push('native')
                  }
                }
              }
              await fs.writeFile(
                pkgDataPath,
                JSON.stringify(pkgData, null, 2),
                'utf8'
              )
            }
          })

        await rootSpan
          .traceChild('packing packages')
          .traceAsyncFn(async (packingSpan) => {
            // wait to pack packages until after dependency paths have been updated
            // to the correct versions
            const promises = []
            for (const pkgName of pkgDatas.keys()) {
              promises.push(
                packingSpan
                  .traceChild(`pack ${pkgName}`)
                  .traceAsyncFn(async () => {
                    const { pkg, pkgPath } = pkgDatas.get(pkgName)
                    await exec(
                      `cd ${pkgPath} && yarn pack -f ${pkg}-packed.tgz`,
                      true,
                      {
                        env: {
                          // Yarn installed through corepack will not run in pnpm project without this env var set
                          // This var works for corepack >=0.15.0
                          COREPACK_ENABLE_STRICT: '0',
                        },
                      }
                    )
                  })
              )
            }

            await Promise.all(promises)
          })

        return pkgPaths
      })
    },
  }
}
