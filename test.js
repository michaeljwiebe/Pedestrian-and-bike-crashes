const data = require('./testData.json')
const incidents = require('./testIncident.json')
const {
  filterIncidentsWithPedBikeUpdates,
  filterVehicleOnlyIncidents,
  filterPedBikeIncidents,
  handleFiltering
} = require("./index")

// console.log(data.results.map(x => x.title))

const checkText = (x) => ({
  raw: x.raw,
  updates: x.updates && Object.values(x.updates).map(update => update.text)
})

// console.log(filterIncidentsWithPedBikeUpdates(incidents).map(x => checkText(x)))

// console.log(filterPedBikeIncidents(data.results).map(x => checkText(x)))

// console.log(filterVehicleOnlyIncidents(incidents).map(x => checkText(x)))

// console.log(handleFiltering(data.results).map(x => checkText(x)))