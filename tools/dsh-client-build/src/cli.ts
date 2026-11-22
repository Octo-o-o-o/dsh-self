import { buildClientPackage } from './build.js'

export { buildClientPackage }

if (process.argv[1] && process.argv[2]) {
  const result = await buildClientPackage(process.argv[2])
  console.log(JSON.stringify(result, undefined, 2))
}
