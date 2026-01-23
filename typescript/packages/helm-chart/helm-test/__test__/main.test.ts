/**
 * Unit tests for main.run helm-test functionality
 */

let main: any
let core: any
let utils: any

describe('main.run helm-test', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    jest.clearAllMocks()
    jest.resetModules()

    process.env = { ...OLD_ENV }

    jest.doMock('@actions/core', () => ({
      startGroup: jest.fn(),
      endGroup: jest.fn(),
      summary: {
        addHeading: jest.fn().mockReturnThis(),
        addRaw: jest.fn().mockReturnThis(),
        addTable: jest.fn().mockReturnThis(),
        addBreak: jest.fn().mockReturnThis(),
        addDetails: jest.fn().mockReturnThis(),
        write: jest.fn().mockResolvedValue(undefined)
      },
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      setFailed: jest.fn()
    }))

    jest.doMock('fs', () => ({
      existsSync: jest.fn(() => false),
      mkdirSync: jest.fn(),
      rmSync: jest.fn(),
      constants: {
        O_RDONLY: 0
      },
      promises: {
        access: jest.fn(),
        appendFile: jest.fn(),
        writeFile: jest.fn()
      }
    }))

    jest.doMock('path', () => ({
      parse: jest.fn((p: string) => ({ dir: p, base: p, ext: '', name: '', root: '' })),
      format: jest.fn((obj: any) => obj.dir),
      join: jest.fn((...parts: string[]) => parts.join('/'))
    }))

    jest.doMock('../../../shared/dist', () => {
      const actualShared = jest.requireActual('../../../shared/dist')
      return {
        __esModule: true,
        ...actualShared,
        utils: {
          ...actualShared.utils,
          assertNullOrEmpty: jest.fn(),
          isFunctionEnabled: jest.fn(),
          unrapYamlbyKey: jest.fn(),
          HelmChart: {
            ...actualShared.utils.HelmChart,
            getInstance: jest.fn(() => ({
              getListingFileContent: jest.fn(() => 'listing-content'),
              unittest: jest.fn(),
              readPipelineFeatureOptions: jest.fn(() => false)
            }))
          }
        }
      }
    })

    jest.isolateModules(() => {
      core = require('@actions/core')
      const shared = require('../../../shared/dist')
      utils = shared.utils
      main = require('../src/main')
    })
  })

  afterAll(() => {
    process.env = OLD_ENV
  })

  let helmChartInstanceMock: any

  function setupHelmChartListingDoc(chartName: string = 'test-chart') {
    process.env.GITHUB_WORKSPACE = '/test/workspace'

    helmChartInstanceMock = {
      getListingFileContent: jest.fn().mockReturnValue(`${chartName}:
  dir: /test/workspace/charts/${chartName}
  name: ${chartName}
  folderName: ${chartName}
  relativePath: charts/${chartName}
  manifestPath: charts`),
      unittest: jest.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
      readPipelineFeatureOptions: jest.fn().mockReturnValue(false)
    }

    utils.HelmChart.getInstance.mockReturnValue(helmChartInstanceMock)
    utils.isFunctionEnabled.mockReturnValue(true)
    utils.assertNullOrEmpty.mockImplementation(() => {})

    // Mock unrapYamlbyKey to handle different keys
    utils.unrapYamlbyKey.mockImplementation((doc: any, key: string, defaultValue?: any) => {
      if (typeof doc === 'string') {
        return doc
      }

      const value = doc?.get?.(key)
      if (value === undefined || value === null) {
        return defaultValue
      }
      // Convert YAML sequence to array
      if (value && typeof value.toJSON === 'function') {
        return value.toJSON()
      }
      return value
    })
  }

  describe('successful test execution', () => {
    it('should run helm unittest and report success', async () => {
      setupHelmChartListingDoc()
      helmChartInstanceMock.unittest.mockResolvedValue({ exitCode: 0, stdout: 'Tests passed', stderr: '' })

      await main.run()

      expect(helmChartInstanceMock.unittest).toHaveBeenCalled()
      expect(core.setFailed).not.toHaveBeenCalled()
      expect(core.summary.write).toHaveBeenCalled()
    })

    it('should handle multiple charts in parallel', async () => {
      process.env.GITHUB_WORKSPACE = '/test/workspace'

      helmChartInstanceMock = {
        getListingFileContent: jest.fn().mockReturnValue(`chart1:
  dir: /test/workspace/charts/chart1
  name: chart1
  folderName: chart1
  relativePath: charts/chart1
  manifestPath: charts
chart2:
  dir: /test/workspace/charts/chart2
  name: chart2
  folderName: chart2
  relativePath: charts/chart2
  manifestPath: charts`),
        unittest: jest.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        readPipelineFeatureOptions: jest.fn().mockReturnValue(false)
      }

      utils.HelmChart.getInstance.mockReturnValue(helmChartInstanceMock)
      utils.isFunctionEnabled.mockReturnValue(true)
      utils.assertNullOrEmpty.mockImplementation(() => {})

      await main.run()

      // Should have been called for both charts
      expect(helmChartInstanceMock.unittest).toHaveBeenCalledTimes(2)
    })
  })

  describe('skipping charts', () => {
    it('should skip when no tests directory exists', async () => {
      setupHelmChartListingDoc()
      helmChartInstanceMock.unittest.mockResolvedValue({
        exitCode: -1,
        stdout: '',
        stderr: 'No tests directory found'
      })

      await main.run()

      expect(core.setFailed).not.toHaveBeenCalled()
      expect(core.summary.write).toHaveBeenCalled()
    })

    it('should skip when disabled via .ci.config.yaml', async () => {
      setupHelmChartListingDoc()
      utils.isFunctionEnabled.mockReturnValue(false) // Disabled

      await main.run()

      expect(helmChartInstanceMock.unittest).not.toHaveBeenCalled()
      expect(core.setFailed).not.toHaveBeenCalled()
    })
  })

  describe('test failures', () => {
    it('should fail the action when tests fail', async () => {
      setupHelmChartListingDoc()
      helmChartInstanceMock.unittest.mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: 'Test assertion failed'
      })

      await main.run()

      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('test-chart'))
    })

    it('should report multiple failed charts', async () => {
      process.env.GITHUB_WORKSPACE = '/test/workspace'

      helmChartInstanceMock = {
        getListingFileContent: jest.fn().mockReturnValue(`chart1:
  dir: /test/workspace/charts/chart1
  name: chart1
  folderName: chart1
  relativePath: charts/chart1
  manifestPath: charts
chart2:
  dir: /test/workspace/charts/chart2
  name: chart2
  folderName: chart2
  relativePath: charts/chart2
  manifestPath: charts`),
        unittest: jest.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'Failed' }),
        readPipelineFeatureOptions: jest.fn().mockReturnValue(false)
      }

      utils.HelmChart.getInstance.mockReturnValue(helmChartInstanceMock)
      utils.isFunctionEnabled.mockReturnValue(true)
      utils.assertNullOrEmpty.mockImplementation(() => {})

      await main.run()

      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('chart1'))
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('chart2'))
    })
  })

  describe('GitHub summary output', () => {
    it('should write summary with table and legend', async () => {
      setupHelmChartListingDoc()
      helmChartInstanceMock.unittest.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })

      await main.run()

      expect(core.summary.addHeading).toHaveBeenCalledWith('Helm Chart Test Results')
      expect(core.summary.addTable).toHaveBeenCalled()
      expect(core.summary.addDetails).toHaveBeenCalledWith('Legend', expect.any(String))
      expect(core.summary.write).toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('should handle missing GITHUB_WORKSPACE', async () => {
      delete process.env.GITHUB_WORKSPACE
      utils.assertNullOrEmpty.mockImplementation(() => {
        throw new Error('Missing env `GITHUB_WORKSPACE`!')
      })

      await main.run()

      expect(core.setFailed).toHaveBeenCalledWith('Missing env `GITHUB_WORKSPACE`!')
    })

    it('should handle errors from helm unittest', async () => {
      setupHelmChartListingDoc()
      helmChartInstanceMock.unittest.mockRejectedValue(new Error('Helm unittest error'))

      await main.run()

      expect(core.setFailed).toHaveBeenCalledWith('Helm unittest error')
    })
  })
})
