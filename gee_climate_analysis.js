// ███████████████████████████████████████████████████████████████████████████████
// ███████████████████ GEE CLIMATE ANALYSIS APP ██████████████████████████████████
// ███████████████████████████████████████████████████████████████████████████████
// This app allows users to analyze ERA5 Land data for a user-defined study area.
// Users can define their study area via GEE Asset ID, file upload (GeoJSON/KML - experimental), or drawing.
// The app calculates and visualizes yearly, monthly, and seasonal temperature
// and precipitation, provides CSV download links, and displays a temperature anomaly raster.

// ███████████████████████████████████████████████████████████████████████████████
// ███████████████████ GLOBAL CONFIGURATION ██████████████████████████████████████
// ███████████████████████████████████████████████████████████████████████████████

var START_YEAR = 1950;
var END_YEAR = 2025; // Adjusted END_YEAR to ensure data availability for anomaly of latest full year
var END_YEAR_SEASONAL = 2025; // Adjusted for seasonal needing year+1 data

var BASELINE_ANOMALY_START_YEAR = 1970; // Updated baseline start year
var BASELINE_ANOMALY_END_YEAR = 1990; // Updated baseline end year

var ERA5_LAND_MONTHLY = ee.ImageCollection('ECMWF/ERA5_LAND/MONTHLY_AGGR');
var TEMP_BAND = 'temperature_2m';
var PRECIP_BAND = 'total_precipitation_sum'; 

var SCALE = 1000; 
var MAX_PIXELS = 1e10;

// Global layer for temperature anomaly
var tempAnomalyLayer = null;
var precipAnomalyLayer = null; // Placeholder for future precip anomaly


// ███████████████████████████████████████████████████████████████████████████████
// ███████████████████ UI SETUP ██████████████████████████████████████████████████
// ███████████████████████████████████████████████████████████████████████████████

// --- Main Panel ---
var mainPanel = ui.Panel({
  style: {width: '380px', padding: '10px'}
});
ui.root.insert(0, mainPanel);

// --- Title and Description ---
mainPanel.add(ui.Label('GEE Climate Analysis App', {fontWeight: 'bold', fontSize: '20px', margin: '10px 0'}));
mainPanel.add(ui.Label(
  'Analyse ERA5 Land monthly data. Define your study area using one of the methods and download the result in CSV format.', // Updated label
  {fontSize: '12px'}));

// --- Study Area Input Method Selection ---
mainPanel.add(ui.Label('1. Define Study Area:', {fontWeight: 'bold', fontSize: '16px', margin: '10px 0 5px 0'}));

var INPUT_METHOD_ASSET = 'GEE Asset ID';
var INPUT_METHOD_UPLOAD = 'Upload File (GeoJSON/KML)';
var INPUT_METHOD_DRAW = 'Draw on Map';

var inputMethodSelect = ui.Select({
  items: [INPUT_METHOD_ASSET, INPUT_METHOD_UPLOAD, INPUT_METHOD_DRAW],
  value: INPUT_METHOD_ASSET,
  onChange: updateStudyAreaInputUI,
  style: {margin: '0 0 10px 0'}
});
mainPanel.add(inputMethodSelect);

// --- Asset ID Input Panel (Initially Visible) ---
var assetIdPanel = ui.Panel([
  ui.Label('Enter GEE Asset ID (FeatureCollection):', {fontSize: '11px'}),
  ui.Textbox({
    placeholder: 'users/username/asset_name',
    style: {width: '280px', margin: '0 0 5px 0'},
    onChange: function(text) { studyArea = null; runAnalysisButton.setDisabled(true); } 
  }),
  ui.Button('Load Asset', loadStudyAreaFromAsset)
], null, {shown: true}); 
var assetIdTextbox = assetIdPanel.widgets().get(1); 

// --- File Upload Panel (Initially Hidden) ---
var fileUploadPanel = ui.Panel(null, null, {shown: false}); 
var fileUploader = null; 

if (typeof ui.FileUpload === 'function') {
  fileUploader = ui.FileUpload({
    accept: '.json,.geojson,.kml',
    style: {width: '280px', margin: '0 0 5px 0'},
    onBERSUploaded: loadStudyAreaFromFile 
  });
  fileUploadPanel.widgets().reset([ 
    ui.Label('Upload GeoJSON or KML file:', {fontSize: '11px'}),
    fileUploader,
    ui.Label('Note: For Shapefiles (.shp), please zip all component files, upload to your GEE Assets, and use the "GEE Asset ID" method. Direct KML parsing is experimental.', {fontSize: '10px', color: 'gray'})
  ]);
} else {
  fileUploadPanel.widgets().reset([
    ui.Label('File upload feature is currently unavailable in this environment.', {color: 'red', fontSize: '11px', fontWeight: 'bold'}),
    ui.Label('Please use "GEE Asset ID" or "Draw on Map" instead.', {fontSize: '11px'})
  ]);
}

// --- Draw on Map Panel (Initially Hidden) ---
var drawButtonPanel = ui.Panel([
  ui.Button('Draw Polygon', function() { drawGeometry('polygon'); }),
  ui.Button('Draw Rectangle', function() { drawGeometry('rectangle'); }),
  ui.Button('Clear Drawing', clearDrawing)
], ui.Panel.Layout.flow('horizontal'), {shown: false});

mainPanel.add(assetIdPanel);
mainPanel.add(fileUploadPanel);
mainPanel.add(drawButtonPanel);
var studyAreaStatusLabel = ui.Label('', {color: 'gray', fontSize: '11px', whiteSpace: 'pre-line'});
mainPanel.add(studyAreaStatusLabel);

// --- Analysis Selection ---
mainPanel.add(ui.Label('2. Select Analyses:', {fontWeight: 'bold', fontSize: '16px', margin: '15px 0 5px 0'}));
var chkYearlyTemp = ui.Checkbox('Yearly Average Temperature', true);
var chkYearlyPrecip = ui.Checkbox('Yearly Total Precipitation', true);
var chkMonthlyClimo = ui.Checkbox('Monthly Climatology (Avg. Temp & Precip)', true);
var chkSeasonalTemp = ui.Checkbox('Seasonal Average Temperature (Summer/Winter)', true);
var chkSeasonalPrecip = ui.Checkbox('Seasonal Total Precipitation (Summer/Winter)', true);
mainPanel.add(chkYearlyTemp).add(chkYearlyPrecip).add(chkMonthlyClimo).add(chkSeasonalTemp).add(chkSeasonalPrecip);

var runAnalysisButton = ui.Button('Run Analysis', runSelectedAnalyses, true, {margin: '10px 0 0 0'}); 
mainPanel.add(runAnalysisButton);

// --- Output Panel ---
mainPanel.add(ui.Label('3. Results:', {fontWeight: 'bold', fontSize: '16px', margin: '15px 0 5px 0'}));
var resultsPanel = ui.Panel(); 
mainPanel.add(resultsPanel);
var statusLabel = ui.Label('', {color: 'gray', whiteSpace: 'pre-line'}); 
mainPanel.add(statusLabel);

var studyArea = null; 
var drawnStudyAreaLayer = null; 

// ███████████████████████████████████████████████████████████████████████████████
// ███████████████████ DATA PROCESSING FUNCTIONS ████████████████████████████████
// ███████████████████████████████████████████████████████████████████████████████

// --- 1. Yearly Mean Temperature ---
function calculateYearlyMeanTemperature(studyAreaGeom, startYear, endYear) {
  var years = ee.List.sequence(startYear, endYear);
  var dataset = ERA5_LAND_MONTHLY.select(TEMP_BAND);

  var yearlyMeans = ee.FeatureCollection(years.map(function(year) {
    var yearlyData = dataset.filter(ee.Filter.calendarRange(year, year, 'year'));
    var clippedYearlyData = yearlyData.map(function(image) {
      return image.clip(studyAreaGeom);
    });
    var meanImage = clippedYearlyData.mean(); 
    
    var yearlyMeanTemp = meanImage.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: studyAreaGeom, 
      scale: SCALE,
      maxPixels: MAX_PIXELS 
    });
    
    var tempK = ee.Number(yearlyMeanTemp.get(TEMP_BAND));
    var tempC = tempK.subtract(273.15);
    
    return ee.Feature(null, {'year': year, 'temperature_C': tempC})
             .set('system:time_start', ee.Date.fromYMD(year, 1, 1).millis());
  }));
  return yearlyMeans.filter(ee.Filter.notNull(['temperature_C']));
}

// --- 2. Yearly Average Total Precipitation ---
function calculateYearlyAveragePrecipitation(studyAreaGeom, startYear, endYear) {
  var years = ee.List.sequence(startYear, endYear);
  var dataset = ERA5_LAND_MONTHLY.select(PRECIP_BAND);

  var yearlyAvgPrecip = ee.FeatureCollection(years.map(function(year) {
    var yearlyData = dataset.filter(ee.Filter.calendarRange(year, year, 'year'))
                            .map(function(img){ return img.clip(studyAreaGeom); });
    
    var yearlySumImage = yearlyData.sum(); 
    
    var meanYearlySumPrecip = yearlySumImage.reduceRegion({
      reducer: ee.Reducer.mean(), 
      geometry: studyAreaGeom,
      scale: SCALE,
      maxPixels: MAX_PIXELS
    });
    
    var precipM = ee.Number(meanYearlySumPrecip.get(PRECIP_BAND));
    var precipMM = precipM.multiply(1000);
    
    return ee.Feature(null, {'year': year, 'precipitation_mm': precipMM})
             .set('system:time_start', ee.Date.fromYMD(year, 1, 1).millis());
  }));
  return yearlyAvgPrecip.filter(ee.Filter.notNull(['precipitation_mm']));
}

// --- 3. Monthly Climatological Averages (Temp & Precip) ---
function calculateMonthlyClimatology(studyAreaGeom, startYear, endYear) {
  var months = ee.List.sequence(1, 12);
  var datasetBase = ERA5_LAND_MONTHLY.select([TEMP_BAND, PRECIP_BAND])
                                 .filter(ee.Filter.calendarRange(startYear, endYear, 'year'));

  var features = months.map(function(month) {
    month = ee.Number(month); // Ensure month is ee.Number
    var monthlyData = datasetBase.filter(ee.Filter.calendarRange(month, month, 'month'))
                             .map(function(img){ return img.clip(studyAreaGeom); });
    
    var monthlyMeanImage = monthlyData.mean(); 
    var monthlyMeanStats = monthlyMeanImage.reduceRegion({ 
      reducer: ee.Reducer.mean(),
      geometry: studyAreaGeom,
      scale: SCALE,
      maxPixels: MAX_PIXELS
    });
    
    var tempK_server = ee.Number(monthlyMeanStats.get(TEMP_BAND));
    var precipM_server = ee.Number(monthlyMeanStats.get(PRECIP_BAND));

    return ee.Feature(null, {
      'month_number': month,
      'month_name': ee.Date.fromYMD(2000, month, 1).format('MMM'), // For CSV export
      'avg_temperature_C': tempK_server.subtract(273.15), 
      'avg_precipitation_mm': precipM_server.multiply(1000) 
    });
  });
  
  return ee.FeatureCollection(features)
           .filter(ee.Filter.and(
             ee.Filter.notNull(['avg_temperature_C']),
             ee.Filter.notNull(['avg_precipitation_mm'])
           ));
}

// --- 4. Seasonal Mean Temperature (Summer/Winter) ---
function calculateSeasonalMeanTemperature(studyAreaGeom, startYear, endYearSeasonal) {
  var years = ee.List.sequence(startYear, endYearSeasonal);
  var datasetBase = ERA5_LAND_MONTHLY.select(TEMP_BAND);
  
  var summerMonths = ee.List.sequence(5, 10); 
  var winterMonthsStart = ee.List.sequence(11, 12); 
  var winterMonthsEnd = ee.List.sequence(1, 4);   

  var seasonalMeans = ee.FeatureCollection(years.map(function(year) {
    var yearInt = ee.Number(year).toInt();
    
    var summerData = datasetBase.filter(ee.Filter.calendarRange(yearInt, yearInt, 'year'))
                            .filter(ee.Filter.inList('month', summerMonths))
                            .map(function(img){ return img.clip(studyAreaGeom); });
    var summerMeanImage = summerData.mean();
    var summerMeanTemp = summerMeanImage.reduceRegion({
      reducer: ee.Reducer.mean(), geometry: studyAreaGeom, scale: SCALE, maxPixels: MAX_PIXELS
    });
    var summerTempK = ee.Number(summerMeanTemp.get(TEMP_BAND));
    var summerTempC = summerTempK.subtract(273.15);

    var winterData = datasetBase.filter(ee.Filter.or(
      ee.Filter.and(ee.Filter.calendarRange(yearInt, yearInt, 'year'), ee.Filter.inList('month', winterMonthsStart)),
      ee.Filter.and(ee.Filter.calendarRange(yearInt.add(1), yearInt.add(1), 'year'), ee.Filter.inList('month', winterMonthsEnd))
    )).map(function(img){ return img.clip(studyAreaGeom); });
    var winterMeanImage = winterData.mean();
    var winterMeanTemp = winterMeanImage.reduceRegion({
      reducer: ee.Reducer.mean(), geometry: studyAreaGeom, scale: SCALE, maxPixels: MAX_PIXELS
    });
    var winterTempK = ee.Number(winterMeanTemp.get(TEMP_BAND));
    var winterTempC = winterTempK.subtract(273.15);
    
    return ee.Feature(null, {
      'year': yearInt, 'summer_temp_C': summerTempC, 'winter_temp_C': winterTempC
    }).set('system:time_start', ee.Date.fromYMD(yearInt, 1, 1).millis());
  }));
  return seasonalMeans.filter(ee.Filter.and(ee.Filter.notNull(['summer_temp_C']), ee.Filter.notNull(['winter_temp_C'])));
}

// --- 5. Seasonal Average Total Precipitation (Summer/Winter) ---
function calculateSeasonalAveragePrecipitation(studyAreaGeom, startYear, endYearSeasonal) {
  var years = ee.List.sequence(startYear, endYearSeasonal);
  var datasetBase = ERA5_LAND_MONTHLY.select(PRECIP_BAND);

  var summerMonths = ee.List.sequence(5, 10); 
  var winterMonthsStart = ee.List.sequence(11, 12); 
  var winterMonthsEnd = ee.List.sequence(1, 4);   

  var seasonalAvgPrecip = ee.FeatureCollection(years.map(function(year) {
    var yearInt = ee.Number(year).toInt();

    var summerData = datasetBase.filter(ee.Filter.calendarRange(yearInt, yearInt, 'year'))
                            .filter(ee.Filter.inList('month', summerMonths))
                            .map(function(img){ return img.clip(studyAreaGeom); });
    var summerSumImage = summerData.sum(); 
    var summerMeanTotalPrecip = summerSumImage.reduceRegion({
      reducer: ee.Reducer.mean(), geometry: studyAreaGeom, scale: SCALE, maxPixels: MAX_PIXELS
    });
    var summerPrecipM = ee.Number(summerMeanTotalPrecip.get(PRECIP_BAND));
    var summerPrecipMM = summerPrecipM.multiply(1000);

    var winterData = datasetBase.filter(ee.Filter.or(
      ee.Filter.and(ee.Filter.calendarRange(yearInt, yearInt, 'year'), ee.Filter.inList('month', winterMonthsStart)),
      ee.Filter.and(ee.Filter.calendarRange(yearInt.add(1), yearInt.add(1), 'year'), ee.Filter.inList('month', winterMonthsEnd))
    )).map(function(img){ return img.clip(studyAreaGeom); });
    var winterSumImage = winterData.sum(); 
    var winterMeanTotalPrecip = winterSumImage.reduceRegion({
      reducer: ee.Reducer.mean(), geometry: studyAreaGeom, scale: SCALE, maxPixels: MAX_PIXELS
    });
    var winterPrecipM = ee.Number(winterMeanTotalPrecip.get(PRECIP_BAND));
    var winterPrecipMM = winterPrecipM.multiply(1000);
    
    return ee.Feature(null, {
      'year': yearInt, 'summer_precip_mm': summerPrecipMM, 'winter_precip_mm': winterPrecipMM
    }).set('system:time_start', ee.Date.fromYMD(yearInt, 1, 1).millis());
  }));
  return seasonalAvgPrecip.filter(ee.Filter.and(ee.Filter.notNull(['summer_precip_mm']), ee.Filter.notNull(['winter_precip_mm'])));
}


// --- 6. Temperature Anomaly Raster Display ---
function displayTemperatureAnomaly(studyAreaGeom, targetYear, baselineStartYr, baselineEndYr, layerVarName) {
    if (layerVarName === 'temp_anomaly_layer' && tempAnomalyLayer) {
        Map.layers().remove(tempAnomalyLayer);
        tempAnomalyLayer = null;
    }
    // Add similar logic for precipAnomalyLayer if implementing later

    var currentStatus = statusLabel.getValue();
    statusLabel.setValue(currentStatus + 'Calculating temperature anomaly raster ('+ targetYear + ' vs ' + baselineStartYr + '-' + baselineEndYr + ')...\n');

    var baselineMonthlyMeansK = ee.ImageCollection.fromImages(
        ee.List.sequence(1, 12).map(function(m) {
            return ERA5_LAND_MONTHLY
                .filter(ee.Filter.calendarRange(baselineStartYr, baselineEndYr, 'year'))
                .filter(ee.Filter.calendarRange(m, m, 'month'))
                .select(TEMP_BAND)
                .mean()
                .set('month', m);
        })
    );

    var baselineAnnualMeanK = baselineMonthlyMeansK.mean();
    var targetYearMeanK = ERA5_LAND_MONTHLY
        .filter(ee.Filter.calendarRange(targetYear, targetYear, 'year'))
        .select(TEMP_BAND)
        .mean();

    // Evaluate necessary inputs to ensure they are valid images before proceeding
    ee.Image(baselineAnnualMeanK).bandNames().evaluate(function(baselineBands, baselineFailure) {
        if (baselineFailure || !baselineBands || baselineBands.length === 0) {
            statusLabel.setValue(statusLabel.getValue() + 'Failed to compute baseline image for anomaly: ' + baselineFailure + '\n');
            return;
        }
        ee.Image(targetYearMeanK).bandNames().evaluate(function(targetBands, targetFailure) {
            if (targetFailure || !targetBands || targetBands.length === 0) {
                statusLabel.setValue(statusLabel.getValue() + 'Failed to compute target year image for anomaly: ' + targetFailure + '\n');
                return;
            }

            var baselineAnnualMeanC = ee.Image(baselineAnnualMeanK).subtract(273.15);
            var targetYearMeanC = ee.Image(targetYearMeanK).subtract(273.15);
            var anomalyImageC = targetYearMeanC.subtract(baselineAnnualMeanC);

            var visParams = {
                min: -3, max: 3,
                palette: ['#0000FF', '#00FFFF', '#FFFFFF', '#FFFF00', '#FF0000'] // Blue-Cyan-White-Yellow-Red
            };
            
            var clippedAnomaly = anomalyImageC.clip(studyAreaGeom);
            
            if (layerVarName === 'temp_anomaly_layer') {
                tempAnomalyLayer = ui.Map.Layer(clippedAnomaly, visParams, 'Temp. Anomaly (' + targetYear + ')');
                Map.layers().add(tempAnomalyLayer);
            }
            statusLabel.setValue(statusLabel.getValue() + 'Temperature anomaly raster displayed.\n');
        });
    });
}


// ███████████████████████████████████████████████████████████████████████████████
// ███████████████████ UI HANDLERS & APP LOGIC ███████████████████████████████████
// ███████████████████████████████████████████████████████████████████████████████

function updateStudyAreaInputUI(selectedMethod) {
  assetIdPanel.style().set('shown', selectedMethod === INPUT_METHOD_ASSET);
  fileUploadPanel.style().set('shown', selectedMethod === INPUT_METHOD_UPLOAD);
  drawButtonPanel.style().set('shown', selectedMethod === INPUT_METHOD_DRAW);
  
  studyArea = null;
  if (drawnStudyAreaLayer) Map.layers().remove(drawnStudyAreaLayer); drawnStudyAreaLayer = null;
  if (tempAnomalyLayer) Map.layers().remove(tempAnomalyLayer); tempAnomalyLayer = null;
  // if (precipAnomalyLayer) Map.layers().remove(precipAnomalyLayer); precipAnomalyLayer = null;


  Map.drawingTools().clear(); 
  Map.drawingTools().setShown(selectedMethod === INPUT_METHOD_DRAW); 
  
  studyAreaStatusLabel.setValue('');
  runAnalysisButton.setDisabled(true); 
}

function setStudyAreaFeedback(message, isError) {
  studyAreaStatusLabel.setValue(message);
  studyAreaStatusLabel.style().set('color', isError ? 'red' : 'green');
  runAnalysisButton.setDisabled(isError || !studyArea); // Disable if error OR if studyArea is null
  if (!isError && studyArea) {
     var fcToDisplay = studyArea; // studyArea should always be FC
     if (fcToDisplay instanceof ee.FeatureCollection) {
        Map.centerObject(fcToDisplay);
        if (drawnStudyAreaLayer) Map.layers().remove(drawnStudyAreaLayer); 
        drawnStudyAreaLayer = Map.addLayer(fcToDisplay, {color: '00FF00'}, 'Study Area');
     }
  } else if (isError) { // If there's an error, ensure studyArea is also cleared
      studyArea = null;
  }
}

function loadStudyAreaFromAsset() {
  var assetId = assetIdTextbox.getValue();
  if (!assetId) {
    setStudyAreaFeedback('Please enter an Asset ID.', true);
    return;
  }
  studyAreaStatusLabel.setValue('Loading GEE Asset...');
  studyAreaStatusLabel.style().set('color', 'gray');
  
  try {
    var fc = ee.FeatureCollection(assetId);
    fc.limit(1).evaluate(function(features, failure) {
      if (failure) {
        setStudyAreaFeedback('Error evaluating Asset: ' + failure, true);
        return;
      }
      if (features && features.features.length > 0 && features.features[0].geometry) {
        studyArea = fc; 
        setStudyAreaFeedback('Study area loaded from Asset: ' + assetId, false);
      } else {
        setStudyAreaFeedback('Asset loaded but it is empty or has no geometry.', true);
      }
    });
  } catch (e) {
    setStudyAreaFeedback('Error loading Asset: ' + e.message.substring(0,100) + '...', true);
  }
}

function loadStudyAreaFromFile(blobInfo) {
  if (!fileUploader) { 
      setStudyAreaFeedback('File upload component is not available.', true);
      return;
  }
  if (!blobInfo || !blobInfo.name) {
    setStudyAreaFeedback('File upload failed or no file selected.', true);
    return;
  }
  studyAreaStatusLabel.setValue('Processing uploaded file: ' + blobInfo.name);
  studyAreaStatusLabel.style().set('color', 'gray');
  
  var fileName = blobInfo.name.toLowerCase();
  
  try {
    var reader = new FileReader();
    reader.onload = function(e) {
      var contents = e.target.result;
      try {
        var parsedFc = null;
        if (fileName.endsWith('.geojson') || fileName.endsWith('.json')) {
          var geoJson = JSON.parse(contents);
          if (geoJson.type === 'FeatureCollection') {
            var eeFeatures = geoJson.features.map(function(f) { 
              if (f.geometry) return ee.Feature(f.geometry, f.properties);
              return null; 
            }).filter(function(f) { return f !== null; }); 
            if (eeFeatures.length > 0) parsedFc = ee.FeatureCollection(eeFeatures);
          } else if (geoJson.type === 'Feature' && geoJson.geometry) {
            parsedFc = ee.FeatureCollection([ee.Feature(geoJson.geometry, geoJson.properties)]);
          } else if (geoJson.type && geoJson.coordinates) { 
             parsedFc = ee.FeatureCollection([ee.Feature(ee.Geometry(geoJson))]);
          }

          if (parsedFc) {
            studyArea = parsedFc;
            setStudyAreaFeedback('GeoJSON file "' + blobInfo.name + '" loaded successfully.', false);
          } else {
            setStudyAreaFeedback('GeoJSON file "' + blobInfo.name + '" does not contain valid geographic features or is empty.', true);
          }
        } else if (fileName.endsWith('.kml')) {
          setStudyAreaFeedback('KML file "' + blobInfo.name + '" received. For reliable use, please upload KML to GEE Assets and use Asset ID method.', true);
        } else {
          setStudyAreaFeedback('Unsupported file type: ' + blobInfo.name + '. Please use GeoJSON. For SHP/KML, upload to GEE Assets.', true);
        }
      } catch (parseError) {
        setStudyAreaFeedback('Error parsing file "' + blobInfo.name + '": ' + parseError.message.substring(0,100) + '...', true);
      }
      if (fileUploader) fileUploader.setValue(null); 
    };
    reader.onerror = function() {
      setStudyAreaFeedback('Error reading file: ' + blobInfo.name, true);
      if (fileUploader) fileUploader.setValue(null); 
    };
    reader.readAsText(blobInfo.file); 
  } catch (e) {
    setStudyAreaFeedback('Error initiating file read: ' + e.message.substring(0,100) + '...', true);
    if (fileUploader) fileUploader.setValue(null); 
  }
}

var drawingTools = Map.drawingTools();
drawingTools.setShown(false); 
while (drawingTools.layers().length() > 0) { drawingTools.layers().remove(drawingTools.layers().get(0)); }
var dummyGeometryLayer = ui.Map.GeometryLayer({geometries: null, name: 'drawn_geometry', color: '23cba7', shown: false});
drawingTools.layers().add(dummyGeometryLayer);

function clearDrawing() {
  drawingTools.clear();
  if (drawnStudyAreaLayer) Map.layers().remove(drawnStudyAreaLayer); drawnStudyAreaLayer = null;
  if (tempAnomalyLayer) Map.layers().remove(tempAnomalyLayer); tempAnomalyLayer = null;
  studyArea = null;
  setStudyAreaFeedback('Drawing cleared. Draw a new area.', true); 
}

function drawGeometry(shapeType) {
  clearDrawing(); 
  drawingTools.setShape(shapeType); 
  drawingTools.draw();
  setStudyAreaFeedback('Draw ' + shapeType + ' on the map.', false); 
  runAnalysisButton.setDisabled(true);
}

drawingTools.onDraw(function(e) {
  if (drawnStudyAreaLayer) Map.layers().remove(drawnStudyAreaLayer); 
  studyArea = ee.FeatureCollection([ee.Feature(e.geometry)]); 
  drawnStudyAreaLayer = Map.addLayer(studyArea, {color: '00FF00'}, 'Drawn Study Area');
  setStudyAreaFeedback('Area drawn successfully.', false);
  drawingTools.stop(); 
});

drawingTools.onEdit(function(e) {
    if (drawnStudyAreaLayer) Map.layers().remove(drawnStudyAreaLayer);
    studyArea = ee.FeatureCollection([ee.Feature(e.geometry)]); 
    drawnStudyAreaLayer = Map.addLayer(studyArea, {color: '00DD00'}, 'Edited Study Area'); 
    setStudyAreaFeedback('Drawn area edited.', false);
});

function runSelectedAnalyses() {
  resultsPanel.clear(); 
  statusLabel.setValue('Initiating analysis...\n'); 
  statusLabel.style().set('color', 'orange');

  if (tempAnomalyLayer) { Map.layers().remove(tempAnomalyLayer); tempAnomalyLayer = null; }
  // if (precipAnomalyLayer) { Map.layers().remove(precipAnomalyLayer); precipAnomalyLayer = null; }


  if (!studyArea) { 
    statusLabel.setValue('Error: Study area is not defined. Please load or draw a study area first.');
    statusLabel.style().set('color', 'red');
    runAnalysisButton.setDisabled(true); 
    return;
  }

  var currentStudyAreaFc = studyArea; // studyArea should always be a FeatureCollection by now
  
  currentStudyAreaFc.size().evaluate(function(size, fcFailure) {
    if (fcFailure) {
      statusLabel.setValue('Error checking study area size: ' + fcFailure);
      statusLabel.style().set('color', 'red'); runAnalysisButton.setDisabled(true); return;
    }
    if (size === 0) {
      statusLabel.setValue('Error: The study area FeatureCollection is empty.');
      statusLabel.style().set('color', 'red'); runAnalysisButton.setDisabled(true); return;
    }

    var currentStatus = statusLabel.getValue() + 'Study area contains ' + size + ' feature(s). Checking geometry...\n';
    statusLabel.setValue(currentStatus);
    var studyAreaGeom = currentStudyAreaFc.geometry(); 

    studyAreaGeom.area(SCALE).evaluate(function(area, geomFailure) {
      if (geomFailure) {
        statusLabel.setValue(statusLabel.getValue() + 'Error calculating study area geometry area: ' + geomFailure);
        statusLabel.style().set('color', 'red'); runAnalysisButton.setDisabled(true); return;
      }
      if (area === null || typeof area === 'undefined' || area < 1) { 
        statusLabel.setValue(statusLabel.getValue() + 'Error: The study area geometry is invalid or has negligible area (approx. ' + (area !== null && typeof area !== 'undefined' ? area.toFixed(2) : 'N/A') + ' sq m). Please redefine.');
        statusLabel.style().set('color', 'red'); runAnalysisButton.setDisabled(true); return; 
      }
      
      statusLabel.setValue(statusLabel.getValue() + 'Geometry check passed. Area: ' + area.toFixed(2) + ' sq. meters (approx).\nProcessing analyses...\n');
      statusLabel.style().set('color', 'orange'); 
      proceedWithAnalysis(studyAreaGeom); 
    });
  });
}

function proceedWithAnalysis(studyAreaGeomForProcessing) {
  var monthTicks = [
    {v: 1, f: 'Jan'}, {v: 2, f: 'Feb'}, {v: 3, f: 'Mar'}, {v: 4, f: 'Apr'},
    {v: 5, f: 'May'}, {v: 6, f: 'Jun'}, {v: 7, f: 'Jul'}, {v: 8, f: 'Aug'},
    {v: 9, f: 'Sep'}, {v: 10, f: 'Oct'}, {v: 11, f: 'Nov'}, {v: 12, f: 'Dec'}
  ];

  if (chkYearlyTemp.getValue()) {
    addResultSection('Yearly Mean Temperature', function() {
      var fc = calculateYearlyMeanTemperature(studyAreaGeomForProcessing, START_YEAR, END_YEAR);
      var chart = ui.Chart.feature.byFeature({
        features: fc, xProperty: 'system:time_start', yProperties: ['temperature_C']
      }).setOptions({
        title: 'Yearly Mean Temperature', vAxis: {title: 'Temperature (°C)'},
        hAxis: {title: 'Year', format: 'YYYY', gridlines: {count: -1}},
        series: {0: {color: 'red', pointSize: 3, lineWidth: 1}},
        trendlines: { 0: { color: 'darkred', lineWidth: 1, pointSize: 0, type: 'linear', visibleInLegend: true } }
      });
      // Display anomaly raster after chart is processed for this section
      // Use evaluate to ensure fc.size() is computed before calling getInfo()
      fc.size().evaluate(function(size, failure) {
        if (!failure && size > 0) {
          displayTemperatureAnomaly(studyAreaGeomForProcessing, END_YEAR, BASELINE_ANOMALY_START_YEAR, BASELINE_ANOMALY_END_YEAR, 'temp_anomaly_layer');
        }
      });
      return {fc: fc, chart: chart, filename: 'yearly_mean_temp.csv'};
    });
  }

  if (chkYearlyPrecip.getValue()) {
    addResultSection('Yearly Average Total Precipitation', function() {
      var fc = calculateYearlyAveragePrecipitation(studyAreaGeomForProcessing, START_YEAR, END_YEAR);
      var chart = ui.Chart.feature.byFeature({
        features: fc, xProperty: 'system:time_start', yProperties: ['precipitation_mm']
      }).setOptions({
        title: 'Yearly Average Total Precipitation', vAxis: {title: 'Precipitation (mm)'},
        hAxis: {title: 'Year', format: 'YYYY', gridlines: {count: -1}},
        series: {0: {color: 'blue', pointSize: 3, lineWidth: 1}},
        trendlines: { 0: { color: 'darkblue', lineWidth: 1, pointSize: 0, type: 'linear', visibleInLegend: true } }
      });
      return {fc: fc, chart: chart, filename: 'yearly_avg_total_precip.csv'};
    });
  }
  
if (chkMonthlyClimo.getValue()) {
    addResultSection('Monthly Climatology (Avg. Temp & Precip)', function() {
      var fc = calculateMonthlyClimatology(studyAreaGeomForProcessing, START_YEAR, END_YEAR);
      
      // FIX: Changed from ui.Chart.feature.byProperty to ui.Chart.feature.byFeature
      var tempChart = ui.Chart.feature.byFeature({
        features: fc, 
        xProperty: 'month_number', 
        yProperties: ['avg_temperature_C']
      }).setChartType('ColumnChart').setOptions({
          title: 'Monthly Average Temperature (' + START_YEAR + '-' + END_YEAR + ')',
          vAxis: {title: 'Temperature (°C)'}, 
          hAxis: {title: 'Month', ticks: monthTicks}, 
          colors: ['red']
      });
      
      // FIX: Changed from ui.Chart.feature.byProperty to ui.Chart.feature.byFeature
      var precipChart = ui.Chart.feature.byFeature({
        features: fc, 
        xProperty: 'month_number', 
        yProperties: ['avg_precipitation_mm']
      }).setChartType('ColumnChart').setOptions({
          title: 'Monthly Average Precipitation (' + START_YEAR + '-' + END_YEAR + ')',
          vAxis: {title: 'Precipitation (mm)'}, 
          hAxis: {title: 'Month', ticks: monthTicks}, 
          colors: ['blue']
      });
      
      var chartPanel = ui.Panel([tempChart, precipChart]);
      return {fc: fc, chart: chartPanel, filename: 'monthly_climatology.csv'};
    });
  }

  if (chkSeasonalTemp.getValue()) {
    addResultSection('Seasonal Mean Temperature', function() {
      var fc = calculateSeasonalMeanTemperature(studyAreaGeomForProcessing, START_YEAR, END_YEAR_SEASONAL);
      var chart = ui.Chart.feature.byFeature({
        features: fc, xProperty: 'system:time_start', yProperties: ['summer_temp_C', 'winter_temp_C']
      }).setOptions({
        title: 'Seasonal Mean Temperature (Summer: May-Oct, Winter: Nov-Apr)',
        vAxis: {title: 'Temperature (°C)'}, hAxis: {title: 'Year', format: 'YYYY', gridlines: {count: -1}},
        series: {0: {color: 'red', label: 'Summer Temp (°C)', pointSize: 2, lineWidth: 1}, 1: {color: 'purple', label: 'Winter Temp (°C)', pointSize: 2, lineWidth: 1}},
        trendlines: {0: { color: 'darkred', lineWidth: 1, pointSize: 0, type: 'linear', visibleInLegend: false }, 1: { color: 'indigo', lineWidth: 1, pointSize: 0, type: 'linear', visibleInLegend: false }}
      });
      return {fc: fc, chart: chart, filename: 'seasonal_mean_temp.csv'};
    });
  }
  
  if (chkSeasonalPrecip.getValue()) {
    addResultSection('Seasonal Average Total Precipitation', function() {
      var fc = calculateSeasonalAveragePrecipitation(studyAreaGeomForProcessing, START_YEAR, END_YEAR_SEASONAL);
      var chart = ui.Chart.feature.byFeature({
        features: fc, xProperty: 'system:time_start', yProperties: ['summer_precip_mm', 'winter_precip_mm']
      }).setOptions({
        title: 'Seasonal Average Total Precipitation (Summer: May-Oct, Winter: Nov-Apr)',
        vAxis: {title: 'Precipitation (mm)'}, hAxis: {title: 'Year', format: 'YYYY', gridlines: {count: -1}},
        series: {0: {color: 'blue', label: 'Summer Precip (mm)', pointSize: 2, lineWidth: 1}, 1: {color: 'cyan', label: 'Winter Precip (mm)', pointSize: 2, lineWidth: 1}},
        trendlines: {0: { color: 'darkblue', lineWidth: 1, pointSize: 0, type: 'linear', visibleInLegend: false }, 1: { color: 'darkcyan', lineWidth: 1, pointSize: 0, type: 'linear', visibleInLegend: false }}
      });
      return {fc: fc, chart: chart, filename: 'seasonal_avg_total_precip.csv'};
    });
  }
  
  ee.List([1]).evaluate(function() { 
    var currentVal = statusLabel.getValue();
    if (currentVal.indexOf('All selected analyses processing initiated.') === -1) {
        statusLabel.setValue(currentVal + '\nAll selected analyses processing initiated.');
    }
  });
}

function addResultSection(title, calculationFunction) {
  resultsPanel.add(ui.Label(title, {fontWeight: 'bold', fontSize: '14px', margin: '10px 0 5px 0'}));
  var placeholder = ui.Label('Calculating ' + title + '...', {color: 'gray'});
  resultsPanel.add(placeholder);

  ee.List([1]).evaluate(function() { 
    try {
      var result = calculationFunction(); 
      
      if (!result || !result.fc || !(result.fc instanceof ee.FeatureCollection)){
          resultsPanel.remove(placeholder);
          resultsPanel.add(ui.Label('Error: Calculation for ' + title + ' did not return valid data.', {color: 'red'}));
          statusLabel.setValue(statusLabel.getValue() + 'Error in ' + title + ' calculation step.\n');
          return;
      }
      
      result.fc.size().evaluate(function(size, failure) {
        if (failure) {
          resultsPanel.remove(placeholder);
          resultsPanel.add(ui.Label('Error evaluating ' + title + ' data: ' + failure.substring(0,100) + '...', {color: 'red'}));
          statusLabel.setValue(statusLabel.getValue() + 'Error in ' + title + ' data evaluation.\n');
          return;
        }
        if (size === 0) {
           resultsPanel.remove(placeholder);
           resultsPanel.add(ui.Label('No data found for ' + title + ' for the given study area and time range.', {color: 'orange'}));
           statusLabel.setValue(statusLabel.getValue() + title + ' analysis: No data.\n');
           // If this was the yearly temp section, and it had no data, don't try to show anomaly
           if (title.indexOf('Yearly Mean Temperature') > -1 && tempAnomalyLayer) {
               Map.layers().remove(tempAnomalyLayer);
               tempAnomalyLayer = null;
           }
           return;
        }

        resultsPanel.remove(placeholder); 
        resultsPanel.add(result.chart);
        
        var downloadUrl = result.fc.getDownloadURL({
          format: 'csv',
          filename: result.filename
        });
        var downloadLink = ui.Label('Download CSV', {color: 'blue', textDecoration: 'underline', margin: '0 0 10px 5px'});
        downloadLink.setUrl(downloadUrl);
        resultsPanel.add(downloadLink);
        statusLabel.setValue(statusLabel.getValue() + title + ' analysis complete.\n');
      });

    } catch (e) { 
      resultsPanel.remove(placeholder);
      resultsPanel.add(ui.Label('Client-side error in ' + title + ': ' + e.message.substring(0,150) + '...', {color: 'red'}));
      statusLabel.setValue(statusLabel.getValue() + 'Client-side error in ' + title + '.\n');
    }
  });
}

// ███████████████████████████████████████████████████████████████████████████████
// ███████████████████ MAP SETUP █████████████████████████████████████████████████
// ███████████████████████████████████████████████████████████████████████████████
Map.setOptions('HYBRID');
Map.style().set('cursor', 'crosshair');
Map.setCenter(0, 0, 2); 

updateStudyAreaInputUI(inputMethodSelect.getValue());
runAnalysisButton.setDisabled(true); 
