const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone')

dayjs.extend(utc)
dayjs.extend(timezone)

const TZ = 'Asia/Jakarta'

/**
 * Returns a dayjs object in Asia/Jakarta timezone.
 * Use this anywhere you need to display the current time in WIB.
 */
function now() {
  return dayjs().tz(TZ)
}

/**
 * Convert any dayjs object or date-like input to Asia/Jakarta timezone.
 */
function toWIB(input) {
  return dayjs(input).tz(TZ)
}

module.exports = { now, toWIB, TZ }
