'use strict';

// Adapted from technomancer702/nodecast-tv #165.
function parseProgram(value) {
    if (value === undefined || value === null) return null;
    if (!['string', 'number'].includes(typeof value) || !/^\d{1,5}$/.test(String(value)) ||
        Number(value) < 1 || Number(value) > 65535) {
        const error = new Error('Program must be an integer from 1 to 65535');
        error.statusCode = 400;
        throw error;
    }
    return String(Number(value));
}

function selectProgramStreams(result, program = null) {
    if (program === null) return result.streams || [];
    const selected = result.programs?.find(item => String(item.program_id ?? item.program_num) === program);
    if (!selected) throw new Error('Requested program was not found in the stream');
    return selected.streams || [];
}

module.exports = { parseProgram, selectProgramStreams };
