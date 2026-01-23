import * as core from '@actions/core'
import { utils, constants } from '../../../shared/dist'
import * as path from 'path'
import * as yaml from 'yaml'

export interface TestResult {
  chart: string
  status: 'passed' | 'failed' | 'skipped' | 'disabled'
  reason?: string
  relativePath: string
}

/**
 * Process a single Helm chart for unittest
 */
async function processChart(
  item: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  helmChartListingYamlDoc: any,
  utilsHelmChart: utils.HelmChart,
  outputDir: string
): Promise<TestResult> {
  const yamlitem = utils.unrapYamlbyKey(helmChartListingYamlDoc, item)
  const listingYamlDir = utils.unrapYamlbyKey(yamlitem, constants.ListingYamlKeys.dir)
  const listingYamlRelativePath = utils.unrapYamlbyKey(yamlitem, constants.ListingYamlKeys.relativePath)

  const dir: path.ParsedPath = path.parse(listingYamlDir)

  // Check if helm-chart-test is enabled via .ci.config.yaml
  if (!utils.isFunctionEnabled(dir, constants.Functionality.helmChartTest, true)) {
    return {
      chart: item,
      status: 'disabled',
      reason: 'Disabled by .ci.config.yaml',
      relativePath: listingYamlRelativePath
    }
  }

  // Get options from .ci.config.yaml if present
  const options: string[] = []
  const pipelineOptions = utilsHelmChart.readPipelineFeatureOptions(dir, constants.Functionality.helmChartTest)

  if (pipelineOptions !== false) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const optionsDoc: any = new yaml.Document(pipelineOptions)
    if (utils.unrapYamlbyKey(optionsDoc, '--update-snapshot', false)) {
      options.push('--update-snapshot')
    }
  }

  // Run helm unittest
  const chartOutputDir = path.join(outputDir, item)
  const result = await utilsHelmChart.unittest(dir, chartOutputDir, options)

  // Check for no tests directory (exitCode -1 is our custom code)
  if (result.exitCode === -1 && result.stderr === 'No tests directory found') {
    return {
      chart: item,
      status: 'skipped',
      reason: 'No tests directory',
      relativePath: listingYamlRelativePath
    }
  }

  // Check if tests passed or failed
  if (result.exitCode === 0) {
    return {
      chart: item,
      status: 'passed',
      relativePath: listingYamlRelativePath
    }
  }

  return {
    chart: item,
    status: 'failed',
    reason: result.stderr || result.stdout || 'Unknown error',
    relativePath: listingYamlRelativePath
  }
}

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // Get GITHUB_WORKSPACE from environment
    const GITHUB_WORKSPACE = String(process.env[constants.envvars.GITHUB_WORKSPACE])

    utils.assertNullOrEmpty(GITHUB_WORKSPACE, 'Missing env `' + constants.envvars.GITHUB_WORKSPACE + '`!')

    const pathGitRepository = path.parse(GITHUB_WORKSPACE)
    const utilsHelmChart = utils.HelmChart.getInstance()

    // Load helm chart listing
    const helmChartListingFileContent: string = utilsHelmChart.getListingFileContent(pathGitRepository)
    const helmChartListingYamlDoc = new yaml.Document(yaml.parse(helmChartListingFileContent))

    // Output directory for test results
    const outputDir = path.join(GITHUB_WORKSPACE, '.helm-test-output')

    core.startGroup('Helm Chart Unit Testing')

    // Get all chart keys
    const chartKeys = Object.keys(helmChartListingYamlDoc.toJSON())
    const chartCount = chartKeys.length

    core.info(`Processing ${chartCount} chart(s) from listing.`)

    // Process all charts in parallel
    const results = await Promise.all(
      chartKeys.map(async (item) => {
        return await processChart(item, helmChartListingYamlDoc, utilsHelmChart, outputDir)
      })
    )

    // Build summary table
    const tableHeader = [
      { data: 'UID Helm Chart', header: true },
      { data: 'Result', header: true },
      { data: 'Folder', header: true }
    ]

    const tableRows = results.map((result) => {
      let statusIcon: string
      switch (result.status) {
        case 'passed':
          statusIcon = '\u2705' // checkmark
          break
        case 'failed':
          statusIcon = '\u274c' // X
          break
        case 'skipped':
          statusIcon = '\u23ed\ufe0f' // skip
          break
        case 'disabled':
          statusIcon = ':heavy_exclamation_mark:'
          break
      }
      return [result.chart, statusIcon, result.relativePath]
    })

    // Check for any failures
    const failedResults = results.filter((r) => r.status === 'failed')
    const passedResults = results.filter((r) => r.status === 'passed')
    const skippedResults = results.filter((r) => r.status === 'skipped')
    const disabledResults = results.filter((r) => r.status === 'disabled')

    // Write GitHub summary
    await core.summary
      .addHeading('Helm Chart Test Results')
      .addRaw(`\n\nProcessed ${chartCount} chart(s).\n\n`)
      .addTable([tableHeader, ...tableRows])
      .addBreak()
      .addDetails(
        'Legend',
        '\u2705 = Tests passed\n' +
          '\u274c = Tests failed\n' +
          '\u23ed\ufe0f = Skipped (no tests directory)\n' +
          ':heavy_exclamation_mark: = Disabled by ' +
          constants.HelmChartFiles.ciConfigYaml
      )
      .write()

    core.endGroup()

    // Log summary
    core.info(`Summary: ${passedResults.length} passed, ${failedResults.length} failed, ${skippedResults.length} skipped, ${disabledResults.length} disabled`)

    // Fail the action if any tests failed
    if (failedResults.length > 0) {
      const failedCharts = failedResults.map((r) => r.chart).join(', ')
      core.setFailed(`Helm tests failed for: ${failedCharts}`)
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
