const express = require('express');
const app = express();
const fs = require('fs');
const path = require('path');
const cors = require('cors');

app.use(cors());
app.use(express.json());

const admin = require('firebase-admin');
const serviceAccount = require('./config/service-account-key.json'); // Path to your key

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// Manually load the prescription route to ensure the correct URL '/api/prescriptions' is used
const prescriptionRoutes = require('./routes/prescription');
app.use('/api/prescriptions', prescriptionRoutes);

// Dynamically load all other route modules in the routes folder
const routesPath = path.join(__dirname, 'routes');
fs.readdirSync(routesPath).forEach((file) => {
    // Make sure it's a JS file and not the one we already loaded
    if (file.endsWith('.js') && file !== 'prescription.js') {
        const routeName = file.replace('.js', '');
        const routeModule = require(`./routes/${routeName}`);
        app.use(`/api/${routeName}`, routeModule);
    }
});

app.listen(3000, () => console.log('Server running on port 3000'));

