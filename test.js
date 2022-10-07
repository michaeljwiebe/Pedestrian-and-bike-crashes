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

const {summary, incidentList} = handleFiltering(data.results);
console.log('summary', summary)
console.log('incidentList', incidentList.length)