export interface TestResult {
    chart: string;
    status: 'passed' | 'failed' | 'skipped' | 'disabled';
    reason?: string;
    relativePath: string;
}
/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export declare function run(): Promise<void>;
