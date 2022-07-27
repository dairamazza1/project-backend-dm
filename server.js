//EXPRESS
const express = require('express')
const app = express();
const session = require("express-session");

// CLUSTER
const cluster = require("cluster");
const numCPUs = require("os").cpus().length;

// AUTHORIZATION & AUTHENTICATION
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;

// COMPRESSION
const compression = require('compression');
app.use(compression())

//LOG4JS
const log4js = require("log4js");

log4js.configure({
    appenders: {
        miLoggerConsole: { type: "console" },
        miLoggerFileWarn: { type: 'file', filename: 'loggerWarn.log' },
        miLoggerFileError: { type: 'file', filename: 'loggerError.log' }
    },
    categories: {
        default: { appenders: ["miLoggerConsole"], level: "trace" },
        info: { appenders: ["miLoggerConsole"], level: "info" },
        warn: { appenders: ["miLoggerFileWarn"], level: "warn" },
        error: { appenders: ["miLoggerFileError"], level: "error" },
    },
});

// DEPENDENCIAS
const { percentage } = require('./src/utils/percentage') 
const { normalizr } = require('./src/utils/normalizrChat')
const { TIEMPO_EXPIRACION } = require('./src/config/globals')
const {validatePass} = require('./src/utils/passValidator');
const {createHash} = require('./src/utils/hashGenerator')
const routes = require('./src/routes/routes')
const UserModel = require('./src/models/usuarios');
const { PORT } = require('./src/config/globals')
const { MODE } = require('./src/config/globals')

//COOKIES - PERSISTENCIA MONGO
const advancedOptions = { useNewUrlParser: true , useUnifiedTopology: true }

app.use(session({
    secret: 'daira',
    resave: true,
    saveUninitialized: true,
    mongoOptions : advancedOptions,
    cookie: {
        httpOnly: false,
        secure: false,
        maxAge: parseInt(TIEMPO_EXPIRACION)
    }
    })
);

// MIDDLEWARE
app.use(express.json()); 
app.use(express.urlencoded({extended:true}))
app.use(passport.initialize())
app.use(passport.session())

// VIEWS
app.set('views', __dirname + '/src/views');
app.set('view engine', 'ejs'); //se define extensión (motor de plantilla)
app.use(express.static(__dirname + "/public"));

passport.use('login', new LocalStrategy(
    (username, password, callback) => {
        UserModel.findOne({ username: username }, (err, user) => {
            if (err) {
                return callback(err)
            }

            if (!user) {
                console.log('No se encontro usuario');
                return callback(null, false)
            }

            if(!validatePass(user, password)) {
                console.log('Invalid Password');
                return callback(null, false)
            }

            return callback(null, user)
        })
    }
))


passport.use('signup', new LocalStrategy(
    {passReqToCallback: true}, (req, username, password, callback) => {
        UserModel.findOne({ username: username }, (err, user) => {
            if (err) {
                console.log('Hay un error al registrarse');
                return callback(err)
            }
            if (user) {
                console.log('El usuario ya existe');
                return callback(null, false)
            }

            console.log(req.body);

            const newUser = {
                username: username,
                password: createHash(password)
            }

            UserModel.create(newUser, (err, userWithId) => {
                if (err) {
                    console.log('Hay un error al registrarse');
                    return callback(err)
                }

                console.log(userWithId);
                console.log('Registro de usuario satisfactoria');

                return callback(null, userWithId)
            })
        })
    }
))


passport.serializeUser((user, callback) => {
    callback(null, user._id)
})

passport.deserializeUser((id, callback) => {
    UserModel.findById(id, callback)
})

// DAOS
const { ProductoDaoArchivo } = require('./src/daos/productos/ProductosDaoArchivo');
let product = new ProductoDaoArchivo();

const { ChatDaoArchivo } = require('./src/daos/chat/ChatDaoArchivo');
let chat = new ChatDaoArchivo();


// WEB SOCKETS                
const { Server: HttpServer } = require('http');
const { Server: IOServer } = require('socket.io');

const httpServer = new HttpServer(app);
const io = new IOServer(httpServer);

try {
    //Productos WEB SOCKET 
    io.on('connection', async(socket) => {
        // console.log("entró");
        const prod = await product.getAll().then( (obj) =>{
            socket.emit('products', obj);
        })
        socket.on('new-products', async data => {
            const saveObj = await product.save(data);
            io.sockets.emit('products', await product.getAll());
        })
    })  
    //chat WEB SOCKET 
io.on('connection', async (socket) => {
    //envío chat normalizado
    const text = await chat.getAll().then( (obj) =>{ 
        const dataContainer = { id: 1, mensajes: [] };
        dataContainer.mensajes = obj;
        const chatNormalizr = normalizr(dataContainer)
        //console.log("Usuario conectado al Chat"); 
        socket.emit('text', chatNormalizr);
    })
    //guardo nuevo obj y envio % compresion
    socket.on('new-text', async data => {
        const saveObj = await chat.save(data);

        const dataContainer = { id: 1, mensajes: [] };
        dataContainer.mensajes = await chat.getAll();

        let dataNocomprimida = JSON.stringify(dataContainer).length;
        let dataNormalized = normalizr(dataContainer);
        let dataComprimida = JSON.stringify(dataNormalized).length;

        let compression = percentage(dataComprimida, dataNocomprimida);
        
        try {

            socket.emit("compression", compression);
        } catch (error) {
            

            console.log(error);
        }
        io.sockets.emit('text', chat.getAll());
    })
}) 
} catch (error) {
    const logger = log4js.getLogger("error");
    logger.error("Log Error: " , error);
    logger.info("Log Info: ",req.error);

}


//*******************   ENDPOINTS   **********************

//  HOME PAGE
app.get('/', routes.getRoot);

//  LOGIN
app.get('/login', routes.getLogin);
app.post('/login', passport.authenticate('login', { failureRedirect: '/faillogin' }), routes.postLogin);
app.get('/faillogin', routes.getFaillogin);

//  SIGNUP
app.get('/signup', routes.getSignup);
app.post('/signup', passport.authenticate('signup', { failureRedirect: '/failsignup' }), routes.postSignup);
app.get('/failsignup', routes.getFailsignup);

//  LOGOUT
app.get('/logout', routes.getLogout);

// PRODUCTS
app.get('/products', routes.getProducts);

// INFO
app.get("/info", routes.getInfo)

// RAND
app.get("/api/randoms", routes.getRandom);

//  FAIL ROUTE
app.get('*', routes.failRoute);

//SERVIDOR
const server = servidor(MODE); 

function servidor(args) {
    if (args == 'FORK') {
        httpServer.listen(PORT, () => {
            console.log(`Servidor en Puerto ${PORT} - PID WORKER: ${process.pid}`);
            app.on("error", error => console.log(`Error en servidor ${error}`));
        })
    } else {
        if (cluster.isMaster) { 
            console.log(numCPUs);
            console.log(`PID MASTER ${process.pid}`);

            for (let i = 0; i < numCPUs; i++) {
                cluster.fork()
            }

            cluster.on('exit', worker => {
                console.log('Worker', worker.process.pid, 'died')
                cluster.fork()
            })
        } else {
            app.listen(PORT, err => {
                if (!err) console.log(`Servidor express escuchando en el puerto ${PORT} - PID WORKER ${process.pid}`)
            })
        }
    }
}