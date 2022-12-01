// const incidents = require('./testIncident.json')
const {
  filterIncidentsWithPedBikeUpdates,
  filterVehicleOnlyIncidents,
  filterPedBikeIncidents,
  handleFiltering
} = require("./index")
// const representatives = require("./representatives");
const fs = require("fs-extra");
const argv = require('minimist')(process.argv.slice(2))

// console.log(data.results.map(x => x.title))

const checkText = (x) => ({
  raw: x.raw,
  updates: x.updates && Object.values(x.updates).map(update => update.text)
})

const currentDate = new Date();
const errorFilePath = `./errors/${argv.location}/${argv.location}-errors-${currentDate.getMonth()}-${currentDate.getFullYear()}.json`
try {
  errFile = fs.readFileSync(errorFilePath);
} catch (e) {
  fs.writeFile(errorFilePath, JSON.stringify([]))
}
