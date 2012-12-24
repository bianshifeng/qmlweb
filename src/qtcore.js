/* @license

  Copyright (c) 2011 Lauri Paimen <lauri@paimen.info>
  Copyright (c) 2012 Anton Kreuzkamp <akreuzkamp@web.de>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions
  are met:

      * Redistributions of source code must retain the above
        copyright notice, this list of conditions and the following
        disclaimer.

      * Redistributions in binary form must reproduce the above
        copyright notice, this list of conditions and the following
        disclaimer in the documentation and/or other materials
        provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER “AS IS” AND ANY
  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
  PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE
  LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
  OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
  PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
  THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
  TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
  THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
  SUCH DAMAGE.
*/


/*
 * QML engine and elements.
 * 
 * This is the main component of the project. It defines qml engine, elements
 * and helpers for each.
 *
 * Exports:
 *
 * - QMLEngine(element, options) -- Returns new qml engine object, for which:
 *   - loadFile(file) -- Load file to the engine (.qml or .qml.js atm)
 *   - start() -- start the engine/application
 *   - stop() -- stop the engine/application. Restarting is experimental.
 *   element is HTMLCanvasElement and options are for debugging.
 *   For further reference, see testpad and qml viewer applications.
 */

(function() {

var QMLGlobalObject = {
    Qt: {
        rgba: function(r,g,b,a) {
            var rgba = "rgba("
                + Math.round(r * 255) + ","
                + Math.round(g * 255) + ","
                + Math.round(b * 255) + ","
                + a + ")"
            return rgba },
        // Buttons masks
        LeftButton: 1,
        RightButton: 2,
        MiddleButton: 4,
        // Modifiers masks
        NoModifier: 0,
        ShiftModifier: 1,
        ControlModifier: 2,
        AltModifier: 4,
        MetaModifier: 8,
        KeypadModifier: 16 // Note: Not available in web

        }
    },
    // Simple shortcuts to getter & setter functions, coolness with minifier
    GETTER = "__defineGetter__",
    SETTER = "__defineSetter__",
    Undefined = undefined,
    // This registry kind of implements weak-pointers in order to make
    // garbage collecting possible
    propertyUpdaters = [],
    // Stack of Components/Files in whose context variable names are used
    // Used to distribute the Component to all it's children without needing
    // to pass it through all constructors.
    // The last element in the Stack is the currently relevant context.
    workingContext = [],
    // Stack of properties that are currently are beeing evaluated. Used to
    // get the information which property called a certain other property
    // for evaluation and is thus dependant on it.
    evaluatingProperties = [];

/**
 * Inheritance helper
 */
Object.create = function (o) {
    function F() {}
    F.prototype = o;
    return new F();
};

// Helper. Ought to do absolutely nothing.
function noop(){};

// Helper to prevent some minimization cases. Ought to do "nothing".
function tilt() {arguments.length = 0};

// Helper to clone meta-objects for dynamic element creation
function cloneObject(obj) {
    if (null == obj || typeof obj != "object")
        return obj;
    var copy = new obj.constructor();
    for (var attr in obj) {
        if (obj.hasOwnProperty(attr)) {
            if (typeof obj[attr] == "object")
                copy[attr] = cloneObject(obj[attr]);
            else
                copy[attr] = obj[attr];
        }
    }
    return copy;
}

/**
 * Helper function.
 * Prints msg and values of object. Workaround when using getter functions as
 * Chrome (at least) won't show property values for them.
 * @param {String} msg Message
 * @param {Object} obj Object to use (will be "printed", too)
 * @param {Array} vals Values to list from the object.
 */
function descr(msg, obj, vals) {
    var str = msg + ": [" + obj.id + "] ",
        i;
    for (i = 0; i < vals.length; i++) {
        str += vals[i] + "=" + obj[vals[i]] + " ";
    }
    console.log(str, obj);
}

/**
 * QMLTransientValue.
 * Value for setter can be given with this function.
 * The difference is that no change signal is fired for setting the value.
 * @param {any} val Value to be passed.
 * @return {QMLTransientValue} special value for 
 */
function QMLTransientValue(val) {
    this.$val = val;
}

/**
 * Evaluate binding.
 * @param {Object} thisObj Object to be this
 * @param {String} src Source code
 * @param {Object} objectScope Scope for evaluation
 * @param {Object} [globalScope] A second Scope for evaluation (both scopes properties will be directly accessible)
 * @return {any} Resulting object.
 */
function evalBinding(thisObj, src, objectScope, globalScope) {
    var val;
    // If "with" operator gets deprecated, you just have to create var of
    // every property in objectScope and globalScope, assign the values, and run. That'll be quite
    // slow :P
    // todo: use thisObj.
    //console.log("evalBinding objectScope, this, src: ", objectScope, thisObj, src);
    (function() {
        with(objectScope) {
            if (globalScope) {
                with (globalScope) {
                    val = eval(src);
                }
            } else {
                val = eval(src);
            }
        }
    })();
    //console.log("    ->", val);
    return val;
}

/**
 * QML Object constructor.
 * @param {Object} meta Meta information about the object
 * @param {Object} parent Parent object for new object
 * @return {Object} New qml object
 */
function construct(meta, parent, engine) {
    var constructors = {
            MouseArea: QMLMouseArea,
            Image: QMLImage,
            Item: QMLItem,
            Column: QMLItem, // todo
            Row: QMLItem, // todo
            Display: QMLItem, // todo
            Text: QMLText,
            Rectangle: QMLRectangle,
            Repeater: QMLRepeater,
            ListModel: QMLListModel,
            ListElement: QMLListElement,
            QMLDocument: QMLDocument,
            Timer: QMLTimer,
            SequentialAnimation: QMLSequentialAnimation,
            NumberAnimation: QMLNumberAnimation
        },
        item,
        cTree;
        
    if (meta.$class in constructors) {
        item = new constructors[meta.$class](meta, parent, engine);
        item.$$type = meta.$class; // Some debug info, don't depend on existence
        item.$$meta = meta; // Some debug info, don't depend on existence
        return item;
    } else if (cTree = engine.loadComponent(meta.$class)) {
        var component = construct(cTree, {}, engine);
        item = component.$children[0];
        //TODO: These $intern... properties are not nice. Find a better way.
        item.$internChildren = component.$children[0].$children;
        item.$internComponent = component.$children[0].Component;
        meta.$componentMeta = cTree.$children[0];
        if (cTree.$children[0].$defaultProperty) {
            var bindSrc = "function $Qbc(newVal) {" + cTree.$children[0].$defaultProperty.src
                            + " = newVal; };$Qbc";
            item.$applyChild = evalBinding(item, bindSrc, item, item.Component.$scope.getIdScope());
        }
        QMLBaseObject.call(item, meta, parent, engine);
        item.$$type = meta.$class; // Some debug info, don't depend on existence
        item.$$meta = meta; // Some debug info, don't depend on existence
        return item;
    } else {
        console.log("No constructor found for " + meta.$class);
    }
}

function createFunction(obj, funcName) {
    var func;

    function getter() {
        return func;
    }

    function setter(newVal) {
        if (!(newVal instanceof QMLBinding))
            return;
        var src;
        if (newVal.src.search("function") == 0) {
            // The src begins already with "function", so no need to put "function" around it
            src = newVal.src + "; " + funcName;
        } else {
            // The src contains only the function body, so we need to put "function" around it
            src = "var func = function() {"
                    + newVal.src
                    + "}; func";
        }
        var componentScope = obj.Component.$scope.getIdScope();

        func = evalBinding(null, src, obj, componentScope);
    }

    setupGetterSetter(obj, funcName, getter, setter);
}

/**
 * Create property getters and setters for object.
 * @param {Object} obj Object for which gsetters will be set
 * @param {String} propName Property name
 * @param {Object} [options] Options that allow finetuning of the property
 */
function createSimpleProperty(obj, propName, options) {
    if (options == Undefined)
        options = {};
    var changeFuncName = 'on'
                        + propName[0].toUpperCase()
                        + propName.substr(1)
                        + 'Changed',
        binding,
        objectScope = options.altParent || obj,
        val,
        dependantProperties = options.propDepList || [];

    createFunction(obj, changeFuncName);

    // Extended changesignal capabilities
    obj["$" + changeFuncName] = [];

    // Updater recalculates the value of a property if one of the
    // dependencies changed
    function update() {
        if (binding) {
            updaterIndex = propertyUpdaters.indexOf(update);
            if (updaterIndex == -1) {
                propertyUpdaters.push(update);
                updaterIndex = propertyUpdaters.indexOf(update);
                objectScope.$ownPropertyUpdaters.push(updaterIndex);
            }


            val = binding();
            if (obj[changeFuncName])
                obj[changeFuncName]();

            // Trigger extended changesignal capabilities
            for (i in obj["$" + changeFuncName]) {
                obj["$" + changeFuncName][i].call(objectScope, val, obj, propName);
            }

            if (!options.dontCallUpdaters) {
                for (i in dependantProperties) {
                    if (propertyUpdaters[dependantProperties[i]] !== Undefined)
                        propertyUpdaters[dependantProperties[i]].call(objectScope);
                }
            }
        }
    }

    var updaterIndex;

    // Define getter
    function getter() {
        // Find out if this call to the getter is due to a property that is
        // dependant on this one
        if (evaluatingProperties.length !== 0) {
            var item = evaluatingProperties[evaluatingProperties.length - 1];
            if (evaluatingProperties.indexOf(updaterIndex) != -1)
                //TODO: Can this happen without having a binding loop?
                console.log("Probable binding loop detected!");
            else if (dependantProperties.indexOf(item) == -1)
                dependantProperties.push(item);
        }
        return val;
    };

    // Define setter
    function setter(newVal) {
        var i;
        //console.log("set", obj.id || obj, propName, newVal);
        if (newVal instanceof QMLTransientValue) {
            // TransientValue, don't fire signal handlers
            val = newVal.$val;
            binding = false;

            // Trigger extended changesignal capabilities (for internal use)
            for (i in obj["$" + changeFuncName]) {
                obj["$" + changeFuncName][i].call(objectScope, val, obj, propName);
            }
        } else if (newVal instanceof QMLBinding) {
            updaterIndex = propertyUpdaters.indexOf(update);
            if (updaterIndex == -1) {
                propertyUpdaters.push(update);
                updaterIndex = propertyUpdaters.indexOf(update);
                objectScope.$ownPropertyUpdaters.push(updaterIndex);
            }

            evaluatingProperties.push(updaterIndex);

            var bindSrc = "function $Qbc() { var $Qbv = " + newVal.src
                + "; return $Qbv;};$Qbc";
            binding = evalBinding(null, bindSrc, objectScope, workingContext[workingContext.length-1].$scope.getIdScope());
            val = binding();

            evaluatingProperties.pop();

            if (obj[changeFuncName])
                obj[changeFuncName]();

            // Trigger extended changesignal capabilities
            for (i in obj["$" + changeFuncName]) {
                obj["$" + changeFuncName][i].call(objectScope, val, obj, propName);
            }
        } else {
            binding = false;

            val = newVal;

            if (obj[changeFuncName])
                obj[changeFuncName]();

            // Trigger extended changesignal capabilities
            for (i in obj["$" + changeFuncName]) {
                obj["$" + changeFuncName][i].call(objectScope, val, obj, propName);
            }
        }

        if (!options.dontCallUpdaters) {
            for (i in dependantProperties) {
                if (propertyUpdaters[dependantProperties[i]] !== Undefined)
                    propertyUpdaters[dependantProperties[i]].call(objectScope);
            }
        }
    };

    setupGetterSetter(obj, propName, getter, setter);
}

/**
 * Set up simple getter function for property
 */
var setupGetter,
    setupSetter,
    setupGetterSetter;
(function() {

// todo: What's wrong with Object.defineProperty on some browsers?
// Object.defineProperty is the standard way to setup getters and setters.
// However, the following way to use Object.defineProperty don't work on some
// webkit-based browsers, namely Safari, iPad, iPhone and Nokia N9 browser.
// Chrome, firefox and opera still digest them fine.

// So, if the deprecated __defineGetter__ is available, use those, and if not
// use the standard Object.defineProperty (IE for example).

    var useDefineProperty = !(Object[GETTER] && Object[SETTER]);

    if (useDefineProperty) {

        if (!Object.defineProperty) {
            console.log("No __defineGetter__ or defineProperty available!");
        }

        setupGetter = function(obj, propName, func) {
            Object.defineProperty(obj, propName,
                { get: func, configurable: true, enumerable: true } );
        }
        setupSetter = function(obj, propName, func) {
            Object.defineProperty(obj, propName,
                { set: func, configurable: true, enumerable: false });
        }
        setupGetterSetter = function(obj, propName, getter, setter) {
            Object.defineProperty(obj, propName,
                {get: getter, set: setter, configurable: true, enumerable: false });
        }
    } else {
        setupGetter = function(obj, propName, func) {
            obj[GETTER](propName, func);
        }
        setupSetter = function(obj, propName, func) {
            obj[SETTER](propName, func);
        }
        setupGetterSetter = function(obj, propName, getter, setter) {
            obj[GETTER](propName, getter);
            obj[SETTER](propName, setter);
        }
    }

})();
/**
 * Apply properties from meta to item. Skip values in skip.
 * @param {Object} meta Source of properties
 * @param {Object} item Target of property apply
 * @param {Array} [skip] Array of property names to skip
 */
function applyProperties(meta, item, skip) {
    var i;
    skip = skip || [];
    for (i in meta) {
        // skip if required
        if (skip.indexOf(i) != -1) {
            continue;
        }
        // skip global id's and internal values
        if (i == "id" || i[0] == "$") {
            continue;
        }
        // no property should begin with uppercase letter -- those indicate
        // classes
        if (i[0] == i[0].toUpperCase()) {
            console.log(meta, "has", i, "-- bug?");
            continue;
        }
        // Handle objects which are already defined in item differently
        if (Object.prototype.toString.call(meta[i]) == '[object Object]') {
            if (item[i] && !(meta[i] instanceof QMLBinding)) {
                // Apply properties one by one, otherwise apply at once
                // skip nothing
                applyProperties(meta[i], item[i]);
                continue;
            }
        }
        item[i] = meta[i];
    }
}

// ItemModel. EXPORTED.
JSItemModel = function() {
    this.dataChangedCallbacks = [];
    this.rowsInsertedCallbacks = [];
    this.rowsMovedCallbacks = [];
    this.rowsRemovedCallbacks = [];
    this.modelResetCallbacks = [];
    this.roleNames = [];

    this.setRoleNames = function(names) {
        this.roleNames = names;
    }

    this.emitDataChanged = function(startIndex, endIndex) {
        for (var i in this.dataChangedCallbacks) {
            this.dataChangedCallbacks[i](startIndex, endIndex);
        }
    }
    this.emitRowsInserted = function(startIndex, endIndex) {
        for (var i in this.rowsInsertedCallbacks) {
            this.rowsInsertedCallbacks[i](startIndex, endIndex);
        }
    };
    this.emitRowsMoved = function(sourceStartIndex, sourceEndIndex, destinationIndex) {
        for (var i in this.rowsMovedCallbacks) {
            this.rowsMovedCallbacks[i](sourceStartIndex, sourceEndIndex, destinationIndex);
        }
    };
    this.emitRowsRemoved = function(startIndex, endIndex) {
        for (var i in this.rowsRemovedCallbacks) {
            this.rowsRemovedCallbacks[i](startIndex, endIndex);
        }
    };
    this.emitModelReset = function() {
        for (var i in this.modelResetCallbacks) {
            this.modelResetCallbacks[i]();
        }
    };
}

// -----------------------------------------------------------------------------
// Stuff below defines QML things
// -----------------------------------------------------------------------------

// Helper
function unboundMethod() {
    console.log("Unbound method for", this.$$type, this);
}

QMLRenderMode = {
    Canvas: 0,
    DOM: 1
}

// QML engine. EXPORTED.
QMLEngine = function (element, options) {
//----------Public Members----------
    this.fps = 25;
    this.$interval = Math.floor(1000 / this.fps); // Math.floor, causes bugs to timing?
    this.running = false;

    // Mouse Handling
    this.mouseAreas = [];
    this.oldMousePos = {x:0, y:0};

    // List of available Components
    this.components = {};

    this.rootElement = element;
    this.renderMode = element.nodeName == "CANVAS" ? QMLRenderMode.Canvas : QMLRenderMode.DOM;


//----------Public Methods----------
    // Start the engine
    this.start = function()
    {
        var i;
        if (!this.running) {
            element.addEventListener("touchstart", touchHandler);
            element.addEventListener("mousemove", mousemoveHandler);
            this.running = true;
            tickerId = setInterval(tick, this.$interval);
            for (i = 0; i < whenStart.length; i++) {
                whenStart[i]();
            }
            this.$draw();
        }
    }

    // Stop the engine
    this.stop = function()
    {
        var i;
        if (this.running) {
            element.removeEventListener("touchstart", touchHandler);
            element.removeEventListener("mousemove", mousemoveHandler);
            this.running = false;
            clearInterval(tickerId);
            for (i = 0; i < whenStop.length; i++) {
                whenStop[i]();
            }
        }
    }

    // Load file, parse and construct (.qml or .qml.js)
    this.loadFile = function(file) {
        basePath = file.split("/");
        basePath[basePath.length - 1] = "";
        basePath = basePath.join("/");
        var src = getUrlContents(file);
        if (options.debugSrc) {
            options.debugSrc(src);
        }
        this.loadQML(src);
    }
    // parse and construct qml
    this.loadQML = function(src) {
        var tree = parseQML(src);
        if (options.debugTree) {
            options.debugTree(tree);
        }
        doc = construct(tree, {}, this);
        doc.$init();
    }

    this.registerProperty = function(obj, propName)
    {
        var dependantProperties = [];
        var value = obj[propName];

        function getter() {
            if (evaluatingProperties.length !== 0) {
                var item = evaluatingProperties[evaluatingProperties.length - 1];
                if (item[0] !== obj && dependantProperties.indexOf(item) == -1)
                    dependantProperties.push(item);
            }
            return value;
        }

        function setter(newVal) {
            value = newVal;

            for (i in dependantProperties) {
                if (propertyUpdaters[dependantProperties[i]] !== Undefined)
                    propertyUpdaters[dependantProperties[i]]();
            }
        }

        setupGetterSetter(obj, propName, getter, setter);
    }

//Intern

    // Load file, parse and construct as Component (.qml or .qml.js)
    this.loadComponent = function(name)
    {
        if (name in this.components)
            return this.components[name];

        var file = name + ".qml";
        basePath = file.split("/");
        basePath[basePath.length - 1] = "";
        basePath = basePath.join("/");

        var src = getUrlContents(file);
        if (src=="")
            return undefined;
        var tree = parseQML(src);
        this.components[name] = tree;
        return tree;
    }

    this.$getGlobalObj = function()
    {
        return globalObj;
    }

    this.$getTextMetrics = function(text, fontCss)
    {
        canvas.save();
        canvas.font = fontCss;
        var metrics = canvas.measureText(text);
        canvas.restore();
        return metrics;
    }

    this.$setBasePath = function(path)
    {
        basePath = path;
    }

    // Return a path to load the file
    this.$resolvePath = function(file)
    {
        if (file.indexOf("://") != -1) {
            return file;
        } else if (file.indexOf("/") == 0) {
            return file;
        }
        return basePath + file;
    }

    this.$registerStart = function(f)
    {
        whenStart.push(f);
    }

    this.$registerStop = function(f)
    {
        whenStop.push(f);
    }

    this.$addTicker = function(t)
    {
        tickers.push(t);
    }

    this.$removeTicker = function(t)
    {
        var index = tickers.indexOf(t);
        if (index != -1) {
            tickers.splice(index, 1);
        }
    }

    this.size = function()
    {
        return { width: doc.getWidth(), height: doc.getHeight() };
    }

    // Requests draw in case something has probably changed.
    this.$requestDraw = function()
    {
        isDirty = true;
    }

    // Performance measurements
    this.$perfDraw = function(canvas)
    {
        doc.$draw(canvas);
    }

    this.$draw = function()
    {
        if (this.renderMode == QMLRenderMode.DOM)
            return;
        var time = new Date();

        element.height = doc.height;
        element.width = doc.width;

        // Pixel-perfect size
//         canvasEl.style.height = canvasEl.height + "px";
//         canvasEl.style.width = canvasEl.width + "px";

        doc.$draw(canvas);

        if (options.drawStat) {
            options.drawStat((new Date()).getTime() - time.getTime());
        }
    }


//----------Private Methods----------
    // In JS we cannot easily access public members from
    // private members so self acts as a bridge
    var self = this;
    
    // Listen also to touchstart events on supporting devices
    // Makes clicks more responsive (do not wait for click event anymore)
    function touchHandler(e)
    {
        // preventDefault also disables pinching and scrolling while touching
        // on qml application
        e.preventDefault();
        var at = {
            layerX: e.touches[0].pageX - element.offsetLeft,
            layerY: e.touches[0].pageY - element.offsetTop,
            button: 1
        }
        element.onclick(at);

    }

    function mousemoveHandler(e)
    {
        var i;
        for (i in self.mouseAreas) {
            var l = self.mouseAreas[i];
            if (l && l.onExited && l.hoverEnabled
                  && (self.oldMousePos.x >= l.left
                      && self.oldMousePos.x <= l.right
                      && self.oldMousePos.y >= l.top
                      && self.oldMousePos.y <= l.bottom)
                  && !(e.pageX - element.offsetLeft >= l.left
                       && e.pageX - element.offsetLeft <= l.right
                       && e.pageY - element.offsetTop >= l.top
                       && e.pageY - element.offsetTop <= l.bottom) )
                l.onExited();
        }
        for (i in self.mouseAreas) {
            var l = self.mouseAreas[i];
            if (l && l.onEntered && l.hoverEnabled
                  && (e.pageX - element.offsetLeft >= l.left
                      && e.pageX - element.offsetLeft <= l.right
                      && e.pageY - element.offsetTop >= l.top
                      && e.pageY - element.offsetTop <= l.bottom)
                  && !(self.oldMousePos.x >= l.left
                       && self.oldMousePos.x <= l.right
                       && self.oldMousePos.y >= l.top
                       && self.oldMousePos.y <= l.bottom))
                l.onEntered();
        }
        self.oldMousePos = { x: e.pageX - element.offsetLeft,
                            y: e.pageY - element.offsetTop };
    }

    function tick()
    {
        var i,
            now = (new Date).getTime(),
            elapsed = now - lastTick;
        lastTick = now;
        for (i = 0; i < tickers.length; i++) {
            tickers[i](now, elapsed);
        }
        if (isDirty) {
            isDirty = false;
            self.$draw();
        }
    }


//----------Private Members----------
    // Target canvas
    if (this.renderMode == QMLRenderMode.Canvas)
        var canvas = element.getContext('2d');

    var // Global Qt object
        globalObj = Object.create(QMLGlobalObject),
        // Root document of the engine
        doc,
        // Callbacks for stopping or starting the engine
        whenStop = [],
        whenStart = [],
        // Ticker resource id and ticker callbacks
        tickerId,
        tickers = [],
        lastTick = new Date().getTime(),
        // isDirty tells if we should do redraw
        isDirty = true,
        // Base path of qml engine (used for resource loading)
        basePath,
        i;


//----------Construct----------

    options = options || {};

    if (options.debugConsole) {
        // Replace QML-side console.log
        globalObj.console = {};
        globalObj.console.log = function() {
            var args = Array.prototype.slice.call(arguments);
            options.debugConsole.apply(Undefined, args);
        };
    }

    // Register mousehandler for element
    element.onclick = function(e) {
        if (self.running) {
            var i;
            for (i in self.mouseAreas) {
                var l = self.mouseAreas[i];
                var mouse = {
                    accepted: true,
                    button: e.button == 0 ? QMLGlobalObject.Qt.LeftButton :
                            e.button == 1 ? QMLGlobalObject.Qt.RightButton :
                            e.button == 2 ? QMLGlobalObject.Qt.MiddleButton :
                            0,
                    modifiers: (e.ctrlKey * QMLGlobalObject.Qt.CtrlModifier)
                            | (e.altKey * QMLGlobalObject.Qt.AltModifier)
                            | (e.shiftKey * QMLGlobalObject.Qt.ShiftModifier)
                            | (e.metaKey * QMLGlobalObject.Qt.MetaModifier),
                    x: (e.offsetX || e.layerX) - l.left,
                    y: (e.offsetY || e.layerY) - l.top
                };

                if (l.enabled
                && mouse.x >= 0 // equals: e.offsetX >= l.left
                && (e.offsetX || e.layerX) <= l.right
                && mouse.y >= 0 // equals: e.offsetY >= l.top
                && (e.offsetY || e.layerY) <= l.bottom) {
                    // Dispatch mouse event
                    l.mouse = mouse;
                    l.onClicked();
                    l.mouse = Undefined;
                    self.$requestDraw();
                    break;
                }
            }
        }
    }
}

// Base object for all qml thingies
function QMLBaseObject(meta, parent, engine) {
    var i,
        prop,
        self = this;

    if (!this.$draw)
        this.$draw = noop;
    this.Component = workingContext[workingContext.length-1];
    if (!this.$ownPropertyUpdaters)
        this.$ownPropertyUpdaters = [];

    // parent
    this.parent = parent;

    // id
    if (meta.id) {
        this.id = meta.id;
        this.Component.$scope.defId(meta.id, this);
    }

    // children
    this.$children = [];
    function setChildren(childMeta) {
        child = construct(childMeta, this, engine);
        this.$children.push( child );
    }
    function getChildren() {
        return this.$children;
    }
    setupGetterSetter(this, "children", getChildren, setChildren);

    //defaultProperty
    if (!this.$applyChild) {
        this.$applyChild = function(newVal) {
            this.children = newVal;
        };
    }

    // properties
    if (meta.$properties) {
        for (i in meta.$properties) {
            prop = meta.$properties[i];
            if (prop.type == "alias") {
                // alias is reverse property, reverse getters and setters needed
                if (!(prop.value instanceof QMLBinding)) {
                    console.log("Assumption failed: alias was not binding");
                }
                console.log("Aliases not yet supported");
                /* Aliases are not yet supported.
                Following code has never been executed.
                Left here for reference.

                this[GETTER](i, function() {
                    return evalBinding(null, prop.value.src, this);
                });
                this[SETTER](i, function(val) {
                    // val needs to be assigned to property/object/thingie
                    // pointed by value.
                    // todo: not sure how to do this by-the-book.

                    // Way 1:
                    // Inject value-to-be-assigned to scope and alter the
                    // binding to assign the value. Then evaluate. Dirty hack?
                    var scope = this,
                        assignment = "(" + prop.value.src  + ") = $$$val";
                    scope.$$$val = val;
                    evalBinding(null, assignment, scope);

                    // Way 2:
                    // Evaluate binding to get the target object, then simply
                    // assign. Didn't choose this as I'm afraid it wont work for
                    // primitives.
                    // var a = evalBinding(null,
                    //                      prop.value.src, scope);
                    // a = val;
                    //

                    });
                }
                */
            } else {
                createSimpleProperty(this, i);
                this[i] = prop.value;
            }
        }
    }

    // todo: handle alias property assignments here?

    // methods
    function createMethod(item, name, method) {
        // Trick: evaluate method with bindings to get pointer to
        // function that can then be applied with arguments
        // given to this function to do the job (and get the return
        // values).
        var func = evalBinding(null,
                               method + ";" + name,
                               item,
                               workingContext[workingContext.length-1].$scope.getIdScope());
        return function() {
            return func.apply(null, arguments);
        };
    }
    if (meta.$functions) {
        for (i in meta.$functions) {
            this[i] = createMethod(this, i, meta.$functions[i]);
        }
    }

    // signals
    if (meta.$signals) {
        for (i in meta.$signals) {
        
        }
    }

    // Construct from meta, not from this!
    if (meta.$children) {
        for (i = 0; i < meta.$children.length; i++) {
            // This will call the setter of the defaultProperty
            // In case of the default property being children
            // (normal case) it will add a new child
            this.$applyChild(meta.$children[i]);
        }
    }

    if (!this.$init)
        this.$init = [];
    this.$init[0] = function() {
        if (engine.renderMode == QMLRenderMode.DOM
            && self.$domElement !== Undefined && parent.$domElement) {
            parent.$domElement.appendChild(self.$domElement);
        }

        // Apply property-values which are set inside the Component-definition
        if (meta.$componentMeta) {
            workingContext.push(self.$internComponent);
            applyProperties(meta.$componentMeta, self);
            workingContext.pop();
        }

        workingContext.push(self.Component);
        applyProperties(meta, self);
        workingContext.pop();


        if (self.$internChildren != undefined) {
            for (var i in self.$internChildren) {
                for (var j = self.$internChildren[i].$init.length - 1; j>=0; j--)
                    self.$internChildren[i].$init[j]();
            }
        } else {
            for (var i in self.$children) {
                for (var j = self.$children[i].$init.length - 1; j>=0; j--)
                    self.$children[i].$init[j]();
            }
        }
    }
}

// Item qml object
function QMLItem(meta, parent, engine) {
    QMLBaseObject.call(this, meta, parent, engine);
    var child,
        o, i,
        self = this;

    if (engine.renderMode == QMLRenderMode.DOM) {
        this.$domElement = document.createElement("div");
        this.$domElement.style.position = "absolute";
        this.$domElement.style.pointerEvents = "none";
        this.$domElement.className = meta.$class + (this.id ? " " + this.id : "");
    }

    this.$geometry = {
        dependantProperties: [],
        left: 0,
        top: 0,
        hPos: "",
        vPos: "",
        update: function() {
            var w=self.$width,
                h=self.$height;
            switch (self.$geometry.hPos) {
                case "left":
                    self.$geometry.left = self.anchors.left;
                    break;
                case "right":
                    self.$geometry.left = self.anchors.right - w;
                    break;
                case "horizontalCenter":
                    self.$geometry.left = self.anchors.horizontalCenter - w / 2;
                    break;
                case "fill":
                    self.$geometry.left = self.anchors.fill.left;
                    break;
                case "centerIn":
                    self.$geometry.left = self.anchors.centerIn.horizontalCenter - w / 2;
                    break;
                default:
                    self.$geometry.left = self.x + self.parent.left;
                    //TODO: Use real normal dependency-system
                    var updaterIndex = propertyUpdaters.indexOf(self.$geometry.update);
                    if (updaterIndex == -1) {
                        propertyUpdaters.push(self.$geometry.update);
                        updaterIndex = propertyUpdaters.indexOf(self.$geometry.update);
                        self.$ownPropertyUpdaters.push(updaterIndex);
                    }
                    if (self.parent.$geometry.dependantProperties.indexOf(updaterIndex) == -1)
                        self.parent.$geometry.dependantProperties.push(updaterIndex);
            }
            switch (self.$geometry.vPos) {
                case "top":
                    self.$geometry.top = self.anchors.top;
                    break;
                case "bottom":
                    self.$geometry.top = self.anchors.bottom - h;
                    break;
                case "verticalCenter":
                    self.$geometry.top = self.anchors.verticalCenter - h / 2;
                    break;
                case "fill":
                    self.$geometry.top = self.anchors.fill.top;
                    break;
                case "centerIn":
                    self.$geometry.top = self.anchors.centerIn.verticalCenter - h / 2;
                    break;
                default:
                    self.$geometry.top = self.y + self.parent.top;
                    //TODO: Use real normal dependency-system
                    var updaterIndex = propertyUpdaters.indexOf(self.$geometry.update);
                    if (updaterIndex == -1) {
                        propertyUpdaters.push(self.$geometry.update);
                        updaterIndex = propertyUpdaters.indexOf(self.$geometry.update);
                        self.$ownPropertyUpdaters.push(updaterIndex);
                    }
                    if (self.parent.$geometry.dependantProperties.indexOf(updaterIndex) == -1)
                        self.parent.$geometry.dependantProperties.push(updaterIndex);
            }

            if (self.$geometry.geometryChanged) {
                self.$geometry.geometryChanged.call(self);
            }

            for (i in self.$geometry.dependantProperties) {
                if (propertyUpdaters[self.$geometry.dependantProperties[i]] !== Undefined)
                    propertyUpdaters[self.$geometry.dependantProperties[i]]();
            }
            engine.$requestDraw();
        }
    }

    // Anchors. Gah!
    // Create anchors object
    this.anchors = {};

    function marginsSetter(val) {
        this.topMargin = val;
        this.bottomMargin = val;
        this.leftMargin = val;
        this.rightMargin = val;
    }
    setupSetter(this, 'margins', marginsSetter);

    var geometryOptions = {
        altParent: this,
        propDepList: this.$geometry.dependantProperties,
        dontCallUpdaters: true
    };
    // Assign values from meta
    createSimpleProperty(this.anchors, "top", geometryOptions);
    createSimpleProperty(this.anchors, "bottom", geometryOptions);
    createSimpleProperty(this.anchors, "left", geometryOptions);
    createSimpleProperty(this.anchors, "right", geometryOptions);
    createSimpleProperty(this.anchors, "fill", geometryOptions);
    createSimpleProperty(this.anchors, "centerIn", geometryOptions);
    createSimpleProperty(this.anchors, "horizontalCenter", geometryOptions);
    createSimpleProperty(this.anchors, "verticalCenter", geometryOptions);

    // Define anchor getters, returning absolute position
    // left, right, top, bottom, horizontalCenter, verticalCenter, baseline
    // todo: margins
    function leftGetter() {
        if (evaluatingProperties.length !== 0) {
            var updater = evaluatingProperties[evaluatingProperties.length - 1];
            if (this.$geometry.dependantProperties.indexOf(updater) == -1)
                this.$geometry.dependantProperties.push(updater);
        }
        return this.$geometry.left;
    }
    setupGetter(this, "left", leftGetter);

    function rightGetter() {
        return this.left + this.$width;
    }
    setupGetter(this, "right", rightGetter);

    function topGetter() {
        if (evaluatingProperties.length !== 0) {
            var updater = evaluatingProperties[evaluatingProperties.length - 1];
            if (this.$geometry.dependantProperties.indexOf(updater) == -1)
                this.$geometry.dependantProperties.push(updater);
        }
        return this.$geometry.top;
    }
    setupGetter(this, "top", topGetter);

    function bottomGetter() {
        return this.top + this.$height;
    }
    setupGetter(this, "bottom", bottomGetter);

    function hzGetter() {
        return this.left + this.$width / 2;
    }
    setupGetter(this, "horizontalCenter", hzGetter);

    function vzGetter() {
        return this.top + this.$height / 2;
    }
    setupGetter(this, "verticalCenter", vzGetter);

    function blGetter() {
        return this.top;
    }
    setupGetter(this, "baseline", blGetter);

    // Anchoring helpers; $width + $height => Object draw width + height
    function _widthGetter() {
        var t;
        if ((t = this.anchors.fill) !== Undefined) {
            return t.$width;
        };
        return this.implicitWidth || this.width;
    }
    setupGetter(this, "$width", _widthGetter);
    function _heightGetter() {
            var t;
            if ((t = this.anchors.fill) !== Undefined) {
                return t.$height;
            };
            return this.implicitHeight || this.height;
    }
    setupGetter(this, "$height", _heightGetter);

    createSimpleProperty(this, "height");
    createSimpleProperty(this, "implicitWidth");
    createSimpleProperty(this, "implicitHeight");
    createSimpleProperty(this, "rotation");
    createSimpleProperty(this, "spacing");
    createSimpleProperty(this, "visible");
    createSimpleProperty(this, "width");
    createSimpleProperty(this, "x", {
        propDepList: this.$geometry.dependantProperties,
        dontCallUpdaters: true
    });
    createSimpleProperty(this, "y", {
        propDepList: this.$geometry.dependantProperties,
        dontCallUpdaters: true
    });
    createSimpleProperty(this, "z");

    this.$onWidthChanged.push(function() {
        this.$geometry.update();
    });
    this.$onHeightChanged.push(function() {
        this.$geometry.update();
    });
    this.$onXChanged.push(function() {
        this.$geometry.hPos = "x";
        this.$geometry.update();
    });
    this.$onYChanged.push(function() {
        this.$geometry.vPos = "y";
        this.$geometry.update();
    });

    this.anchors.$onTopChanged.push(function() {
        this.$geometry.vPos = "top";
        this.$geometry.update();
    });
    this.anchors.$onBottomChanged.push(function() {
        this.$geometry.vPos = "bottom";
        this.$geometry.update();
    });
    this.anchors.$onLeftChanged.push(function() {
        this.$geometry.hPos = "left";
        this.$geometry.update();
    });
    this.anchors.$onRightChanged.push(function() {
        this.$geometry.hPos = "right";
        this.$geometry.update();
    });
    this.anchors.$onFillChanged.push(function(newVal) {
        //TODO: Use real normal dependency-system
        var updaterIndex = propertyUpdaters.indexOf(this.$geometry.update);
        if (updaterIndex == -1) {
            propertyUpdaters.push(this.$geometry.update);
            updaterIndex = propertyUpdaters.indexOf(this.$geometry.update);
            this.$ownPropertyUpdaters.push(updaterIndex);
        }
        newVal.$geometry.dependantProperties.push(updaterIndex);
        this.$geometry.hPos = "fill";
        this.$geometry.vPos = "fill";
        this.$geometry.update();
    });
    this.anchors.$onCenterInChanged.push(function(newVal) {
        //TODO: Use real normal dependency-system
        var updaterIndex = propertyUpdaters.indexOf(this.$geometry.update);
        if (updaterIndex == -1) {
            propertyUpdaters.push(this.$geometry.update);
            updaterIndex = propertyUpdaters.indexOf(this.$geometry.update);
            this.$ownPropertyUpdaters.push(updaterIndex);
        }
        newVal.$geometry.dependantProperties.push(updaterIndex);
        this.$geometry.hPos = "centerIn";
        this.$geometry.vPos = "centerIn";
        this.$geometry.update();
    });
    this.anchors.$onHorizontalCenterChanged.push(function() {
        this.$geometry.hPos = "horizontalCenter";
        this.$geometry.update();
    });
    this.anchors.$onVerticalCenterChanged.push(function() {
        this.$geometry.vPos = "verticalCenter";
        this.$geometry.update();
    });

    if (engine.renderMode == QMLRenderMode.DOM) {
        this.$onRotationChanged.push(function(newVal) {
            this.$domElement.style.transform = "rotate(" + newVal + "deg)";
            this.$domElement.style.MozTransform = "rotate(" + newVal + "deg)";      //Firefox
            this.$domElement.style.webkitTransform = "rotate(" + newVal + "deg)";   //Chrome and Safari
            this.$domElement.style.OTransform = "rotate(" + newVal + "deg)";        //Opera
            this.$domElement.style.msTransform = "rotate(" + newVal + "deg)";       //IE
        });
        this.$onVisibleChanged.push(function(newVal) {
            this.$domElement.style.visibility = newVal ? "visible" : "hidden";
        });
        this.$geometry.geometryChanged = function() {
            var w = this.$width,
                h = this.$height;
            this.$domElement.style.width = w ? w + "px" : "auto";
            this.$domElement.style.height = h ? h + "px" : "auto";
            this.$domElement.style.top = (this.$geometry.top-this.parent.top) + "px";
            this.$domElement.style.left = (this.$geometry.left-this.parent.left) + "px";
        }
    }

    this.$init.push(function() {
        self.implicitHeight = 0;
        self.implicitWidth = 0;
        self.height = 0;
        self.width = 0;
        self.rotation = 0;
        self.spacing = 0;
        self.visible = new QMLBinding("parent.visible !== false");
        self.x = 0;
        self.y = 0;
        self.z = 0;
    });

    this.$draw = function(c) {
        var i;
        if (this.visible) {
            if (this.$drawItem ) {
                var rotRad = (this.rotation || 0) / 180 * Math.PI,
                    rotOffsetX = Math.sin(rotRad) * this.$width,
                    rotOffsetY = Math.sin(rotRad) * this.$height;
                c.save();

                // Handle rotation
                // todo: implement transformOrigin
                c.translate(this.left + rotOffsetX, this.top + rotOffsetY);
                c.rotate(rotRad);
                c.translate(-this.left, -this.top);
                // Leave offset for drawing...
                this.$drawItem(c);
                c.translate(-rotOffsetX, -rotOffsetY);
                c.restore();
            }
            if (this.$internChildren != undefined) {
                for (i = 0; i < this.$internChildren.length; i++) {
                    if (this.$internChildren[i]
                        && this.$internChildren[i].$draw) {
                        this.$internChildren[i].$draw(c);
                    }
                }
            } else {
                for (i = 0; i < this.$children.length; i++) {
                    if (this.$children[i]
                        && this.$children[i].$draw) {
                        this.$children[i].$draw(c);
                    }
                }
            }
        }
    }
}

function QMLText(meta, parent, engine) {
    QMLItem.call(this, meta, parent, engine);
    var self = this;

    if (engine.renderMode == QMLRenderMode.DOM) {
        // We create another span inside the text to distinguish the actual
        // (possibly html-formatted) text from child elements
        this.$domElement.innerHTML = "<span></span>";
        this.$domElement.style.pointerEvents = "auto";
        this.$domElement.style.whiteSpace = "nowrap";
    }

    // Creates font css description
    function fontCss(font) {
        var css = "";
        font = font || {};
        css += (font.pointSize || 10) + "pt ";
        css += (font.family || "sans-serif") + " ";
        return css;
    }

    this.font = {};
    createSimpleProperty(this.font, "family", { altParent: this });
    createSimpleProperty(this.font, "pointSize", { altParent: this });

    createSimpleProperty(this, "color");

    createSimpleProperty(this, "text");

    if (engine.renderMode == QMLRenderMode.DOM) {
        this.$onColorChanged.push(function(newVal) {
            this.$domElement.style.color = newVal;
        });
        this.$onTextChanged.push(function(newVal) {
            this.$domElement.firstChild.innerHTML = newVal;
            this.$geometry.update();
        });
        this.font.$onPointSizeChanged.push(function(newVal) {
            this.$domElement.style.fontSize = newVal + "pt";
            this.$geometry.update();
        });
        this.font.$onFamilyChanged.push(function(newVal) {
            this.$domElement.style.fontFamily = newVal;
            this.$geometry.update();
        });
        this.$geometry.geometryChanged = function() {
            this.$domElement.style.width = "auto";
            this.$domElement.style.height = "auto";
            this.$domElement.style.top = (this.$geometry.top-this.parent.top) + "px";
            this.$domElement.style.left = (this.$geometry.left-this.parent.left) + "px";
        }
    } else {
        this.$onTextChanged.push(this.$geometry.update);
        this.font.$onFamilyChanged.push(this.$geometry.update);
        this.font.$onPointSizeChanged.push(this.$geometry.update);
    }

    this.$init.push(function() {
        self.font.family = "sans-serif";
        self.font.pointSize = 10;
        self.color = "black";
        self.text = "";
    });

    // Define implicitHeight & implicitWidth

    // Optimization: Remember last text
    // todo: Check for font size, family also
    var lastHText,
        lastH,
        lastHFont;
    function ihGetter(){
        if (evaluatingProperties.length !== 0) {
            var updater = evaluatingProperties[evaluatingProperties.length - 1];
            if (this.$geometry.dependantProperties.indexOf(updater) == -1)
                this.$geometry.dependantProperties.push(updater);
        }

        // DOM
        if (engine.renderMode == QMLRenderMode.DOM) {
            return this.$domElement.offsetHeight;
        }

        // Canvas
        // There is no height available in canvas element, figure out
        // other way
        var font = fontCss(this.font);
        if (lastHText == this.text && lastHFont == font) {
            return lastH;
        }
        var el = document.createElement("span"),
            height;
        el.style.font = font;
        el.innerText = this.text;
        document.body.appendChild(el);
        height = el.offsetHeight;
        document.body.removeChild(el);
        if (!height) {
            // Firefox doesn't support getting the height this way,
            // approximate from point size (full of win) :P
            if (this.font && this.font.pointSize) {
                height = this.font.pointSize * 96 / 72;
            } else {
                height = 10 * 96 / 72;
            }

        }
        lastHText = this.text;
        lastHFont = font;
        lastH = height;
        return height;
    }
    setupGetter(this, "implicitHeight", ihGetter);

    // Optimization: Remember last text
    // todo: Check for font size, family also
    var lastWText,
        lastW,
        lastWFont;
    function iwGetter() {
        if (evaluatingProperties.length !== 0) {
            var updater = evaluatingProperties[evaluatingProperties.length - 1];
            if (this.$geometry.dependantProperties.indexOf(updater) == -1)
                this.$geometry.dependantProperties.push(updater);
        }

        var font = fontCss(this.font);
        if (lastWText == this.text && lastWFont == font) {
            return lastW;
        }

        // DOM
        if (engine.renderMode == QMLRenderMode.DOM) {
            return this.$domElement.offsetWidth;
        }

        // Canvas
        var width;
        width = engine.$getTextMetrics(this.text, font).width;
        lastWText = this.text;
        lastWFont = font;
        lastW = width;
        return width;
    }
    setupGetter(this, "implicitWidth", iwGetter);

    function widthGetter() {
        return this.implicitWidth;
    }
    setupGetter(this, "width", widthGetter);

    function heightGetter() {
        return this.implicitHeight;
    }
    setupGetter(this, "height", heightGetter);

    this.$drawItem = function(c) {
        //descr("draw text", this, ["x", "y", "text",
        //                          "implicitWidth", "implicitHeight"]);
        c.save();
        c.font = fontCss(this.font);
        c.fillStyle = this.color;
        c.textAlign = "left";
        c.textBaseline = "top";
        c.fillText(this.text, this.left, this.top);
        c.restore();
    }
}

function QMLRectangle(meta, parent, engine) {
    QMLItem.call(this, meta, parent, engine);
    var self = this;

    createSimpleProperty(this, "color");
    this.border = {};
    createSimpleProperty(this.border, "color", { altParent: this });
    createSimpleProperty(this.border, "width", { altParent: this });

    if (engine.renderMode == QMLRenderMode.DOM) {
        this.$onColorChanged.push(function(newVal) {
            this.$domElement.style.backgroundColor = newVal;
        });
        this.border.$onColorChanged.push(function(newVal) {
            this.$domElement.style.borderColor = newVal;
        });
        this.border.$onWidthChanged.push(function(newVal) {
            this.$domElement.style.borderWidth = newVal + "px";
            this.$domElement.style.borderStyle = newVal == 0 ? "none" : "solid";
            this.$geometry.update();
        });
    }

    this.$init.push(function() {
        self.color = "white";
        self.border.color = "rgba(0,0,0,0)";
        self.border.width = 0;
    });

    this.$drawItem = function(c) {
        //descr("draw rect", this, ["x", "y", "width", "height", "color"]);
        //descr("draw rect.border", this.border, ["color", "width"]);

        c.save();
        c.fillStyle = this.color;
        c.fillRect(this.left, this.top, this.$width, this.$height);
        c.strokeStyle = this.border.color;
        c.lineWidth = this.border.width;
        c.strokeRect(this.left, this.top, this.$width, this.$height);
        c.restore();
    }
}

function QMLRepeater(meta, parent, engine) {
    this.$applyChild = function(newVal) {
        this.delegate = newVal;
    }

    QMLItem.call(this, meta, parent, engine);
    var self = this;

    createSimpleProperty(this, "model");
    createSimpleProperty(this, "count");

    this.$onModelChanged.push(function() {
        applyModel();
    });

    this.$init.push(function() {
        self.model = 0;
        self.count = 0;
    });

    function applyChildProperties(child) {
        createSimpleProperty(child, "index");
        child.index = new QMLBinding("parent.index");
        var model = self.model instanceof QMLListModel ? self.model.$model : self.model;
        for (var i in model.roleNames) {
            var func = (function(i) { return function() {
                    return model.data(child.index, model.roleNames[i]);
                    }
                })(i);
            setupGetter(child, model.roleNames[i], func);
        }
        for (var i in child.$internChildren)
            applyChildProperties(child.$internChildren[i]);
        for (var i in child.$children)
            applyChildProperties(child.$children[i]);
    }
    function insertChildren(startIndex, endIndex) {
        workingContext.push(self.Component);
        for (var index = startIndex; index < endIndex; index++) {
            var newMeta = cloneObject(self.delegate);
            newMeta.id = newMeta.id + index;
            var newItem = construct(newMeta, self, engine);

            if (engine.renderMode == QMLRenderMode.DOM)
                newItem.$domElement.className += " " + self.delegate.id;

            applyChildProperties(newItem);
            newItem.index = index;
            //TODO: Use parent's children, in order to make it completely transparent
            self.$children.splice(index, 0, newItem);
            for (var i = newItem.$init.length - 1; i>=0; i--)
                newItem.$init[i]();
        }
        for (var i = endIndex; i < self.$children.length; i++) {
            self.$children[i].index = i;
        }
        workingContext.pop();
        self.count = self.$children.length;
    }

    function applyModel() {
        var model = self.model instanceof QMLListModel ? self.model.$model : self.model;
        if (model instanceof JSItemModel) {
            model.dataChangedCallbacks.push(function(startIndex, endIndex) {
                //TODO
            });
            model.rowsInsertedCallbacks.push(insertChildren);
            model.rowsMovedCallbacks.push(function(sourceStartIndex, sourceEndIndex, destinationIndex) {
                var vals = self.$children.splice(sourceStartIndex, sourceEndIndex-sourceStartIndex);
                for (var i = 0; i < vals.length; i++) {
                    self.$children.splice(destinationIndex + i, 0, vals[i]);
                }
                var smallestChangedIndex = sourceStartIndex < destinationIndex
                                        ? sourceStartIndex : destinationIndex;
                for (var i = smallestChangedIndex; i < self.$children.length; i++) {
                    self.$children[i].index = i;
                }
                engine.$requestDraw();
            });
            model.rowsRemovedCallbacks.push(function(startIndex, endIndex) {
                removeChildren(startIndex, endIndex);
                for (var i = startIndex; i < self.$children.length; i++) {
                    self.$children[i].index = i;
                }
                self.count = self.$children.length;
                engine.$requestDraw();
            });
            model.modelResetCallbacks.push(function() {
                removeChildren(0, self.$children.length);
                insertChildren(0, model.rowCount());
                engine.$requestDraw();
            });

            insertChildren(0, model.rowCount());
        } else if (typeof model == "number") {
            removeChildren(0, self.$children.length);
            insertChildren(0, model);
        }
    }

    function removeChildren(startIndex, endIndex) {
        var removed = self.$children.splice(startIndex, endIndex - startIndex);
        for (var index in removed) {
            if (engine.renderMode == QMLRenderMode.DOM)
                removed[index].parent.$domElement.removeChild(removed[index].$domElement);
            removeChildProperties(removed[index]);
        }
    }
    function removeChildProperties(child) {
        if (child.id)
            self.Component.$scope.remId(child.id);
        for (var i in child.$ownPropertyUpdaters)
            propertyUpdaters[child.$ownPropertyUpdaters[i]] = undefined;
        for (var i in child.$children)
            removeChildProperties(child.$children[i])
        for (var i in child.$internChildren)
            removeChildProperties(child.$internChildren[i])
    }
}

function QMLListModel(meta, parent, engine) {
    QMLBaseObject.call(this, meta, parent, engine);
    var self = this;

    this.$model = new JSItemModel();

    this.$model.data = function(index, role) {
        return self.$children[index][role];
    }
    this.$model.rowCount = function() {
        return self.$children.length;
    }
    var roleNames = [];
    for (var i in meta.$children[0]) {
        if (i != "id" && i != "index" && i[0] != "$")
            roleNames.push(i);
    }
    this.$model.setRoleNames(roleNames);

    this.append = function(dict) {
        this.$children.push(dict);
        this.$model.emitRowsInserted(this.$children.length-1, this.$children.length);
    }
    this.clear = function() {
        this.$children = [];
        this.$model.emitModelReset();
    }
    this.get = function(index) {
        return this.$children[index];
    }
    this.insert = function(index, dict) {
        this.$children.splice(index, 0, dict);
        this.$model.emitRowsInserted(index, index+1);
    }
    this.move = function(from, to, n) {
        var vals = this.$children.splice(from, n);
        for (var i = 0; i < vals.length; i++) {
            this.$children.splice(to + i, 0, vals[i]);
        }
        this.$model.emitRowsMoved(from, from+n, to);
    }
    this.remove = function(index) {
        this.$children.splice(index, 1);
        this.$model.emitRowsRemoved(index, index+1);
    }
    this.set = function(index, dict) {
        this.$children[index] = dict;
        engine.$requestDraw();
    }
    this.setProperty = function(index, property, value) {
        this.$children[index][property] = value;
        engine.$requestDraw();
    }
}

function QMLListElement(meta, parent, engine) {
    // QMLListElement can't have children and needs special handling of properties
    // thus we don't use QMLBaseObject for it
    var val;

    for (i in meta) {
        if (i[0] != "$") {
            val = meta[i];
            setupGetterSetter(this, i, function() {
                return val;
            }, function(newVal) {
                val = newVal;
                parent.$model.emitDataChanged(this.index, this.index);
            });
        }
    }

    this.$init = [function() {
        applyProperties(meta, this);
    }];
}

function QMLImage(meta, parent, engine) {
    QMLItem.call(this, meta, parent, engine);
    var img = new Image(),
        self = this;

    if (engine.renderMode == QMLRenderMode.DOM) {
        img.style.width = "100%";
        img.style.height = "100%";
        this.$domElement.appendChild(img);
    }

    // Exports.
    this.Image = {
        // fillMode 
        Stretch: 1,
        PreserveAspectFit: 2,
        PreserveAspectCrop: 3,
        Tile: 4,
        TileVertically: 5,
        TileHorizontally: 6,
        // status
        Null: 1,
        Ready: 2,
        Loading: 3,
        Error: 4
    }

    // no-op properties
    createSimpleProperty(this, "asynchronous");
    createSimpleProperty(this, "cache");
    createSimpleProperty(this, "smooth");

    createSimpleProperty(this, "fillMode");
    createSimpleProperty(this, "mirror");
    createSimpleProperty(this, "progress");
    createSimpleProperty(this, "source");
    createSimpleProperty(this, "status");

    this.sourceSize = {};

    createSimpleProperty(this.sourceSize, "width", { altParent: this });
    createSimpleProperty(this.sourceSize, "height", { altParent: this });

    this.$init.push(function() {
        self.asynchronous = true;
        self.cache = true;
        self.smooth = true;
        self.fillMode = self.Image.Stretch;
        self.mirror = false;
        self.progress = 0;
        self.source = "";
        self.status = self.Image.Null;
        self.sourceSize.width = 0;
        self.sourceSize.height = 0;
    });

    // Actual size of image.
    // todo: bug; implicitWidth|height is not defined this way in docs
    function iwGetter() {
            return this.width || img.naturalWidth;
    }
    setupGetter(this, "implicitWidth", iwGetter);

    function ihGetter() {
        return this.height || img.naturalHeight;
    }
    setupGetter(this, "implicitHeight", ihGetter);

    // Bind status to img element
    img.onload = function() {
        self.progress = 1;
        self.status = self.Image.Ready;
        // todo: it is not right to set these
        self.sourceSize.width = img.naturalWidth;
        self.sourceSize.height = img.naturalHeight;
        self.$geometry.update();
    }
    img.onerror = function() {
        self.status = self.Image.Error;
    }

    // Use extended changesignal capabilities to keep track of source
    this.$onSourceChanged.push(function(val) {
        self.progress = 0;
        self.status = self.Image.Loading;
        img.src = engine.$resolvePath(val);
    });

    this.$drawItem = function(c) {
        //descr("draw image", this, ["left", "top", "$width", "$height", "source"]);

        if (this.fillMode != this.Image.Stretch) {
            console.log("Images support only Image.Stretch fillMode currently");
        }
        if (this.status == this.Image.Ready) {
            c.save();
            c.drawImage(img, this.left, this.top, this.$width, this.$height);
            c.restore();
        } else {
            console.log("Waiting for image to load");
        }
    }
}

function QMLMouseArea(meta, parent, engine) {
    QMLItem.call(this, meta, parent, engine);
    var self = this;

    if (engine.renderMode == QMLRenderMode.DOM)
        this.$domElement.style.pointerEvents = "all";

    createSimpleProperty(this, "acceptedButtons");
    createSimpleProperty(this, "enabled");
    createSimpleProperty(this, "hoverEnabled");
    createFunction(this, "onClicked");
    createFunction(this, "onEntered");
    createFunction(this, "onExited");

    this.$init.push(function() {
        self.acceptedButtons = QMLGlobalObject.Qt.LeftButton;
        self.enabled = true;
        self.hoverEnabled = false;
    });

    if (engine.renderMode == QMLRenderMode.DOM) {
        this.$domElement.onclick = function(e) {
            var mouse = {
                accepted: true,
                button: e.button == 0 ? QMLGlobalObject.Qt.LeftButton :
                        e.button == 1 ? QMLGlobalObject.Qt.RightButton :
                        e.button == 2 ? QMLGlobalObject.Qt.MiddleButton :
                        0,
                modifiers: (e.ctrlKey * QMLGlobalObject.Qt.CtrlModifier)
                        | (e.altKey * QMLGlobalObject.Qt.AltModifier)
                        | (e.shiftKey * QMLGlobalObject.Qt.ShiftModifier)
                        | (e.metaKey * QMLGlobalObject.Qt.MetaModifier),
                x: (e.offsetX || e.layerX),
                y: (e.offsetY || e.layerY)
            };

            if (self.enabled) {
                // Dispatch mouse event
                self.mouse = mouse;
                self.onClicked();
                self.mouse = Undefined;
                engine.$requestDraw();
            }
        }
        this.$domElement.onmouseover = function(e) {
            if (self.hoverEnabled) {
                self.hovered = true;
                if (self.onEntered)
                    self.onEntered();
            }
        }
        this.$domElement.onmouseout = function(e) {
            if (self.hoverEnabled) {
                self.hovered = false;
                if (self.onExited)
                self.onExited();
            }
        }
    } else {
        engine.mouseAreas.push(this);
    }
}

function QMLDocument(meta, parent, engine) {

    var doc,
        // The only item in this document
        item,
        // id's in item scope
        ids = Object.create(engine.$getGlobalObj());

    // todo: imports

    if (meta.$children.length != 1) {
        console.log("QMLDocument: children.length != 1");
    }

    // Build parent
    parent = {};
    parent.left = 0;
    parent.top = 0;
    parent.$domElement = engine.rootElement;

    var Component = {};
    Component.$scope = {
        // Get scope
        get: function() {
            return ids;
        },
        // Get base/id scope
        getIdScope: function() {
            return ids;
        },
        // Define id
        defId: function(name, obj) {
            if (ids[name]) {
                console.log("QMLDocument: overriding " + name
                            + " with object", obj);
            }
            ids[name] = obj;
        },
        // Remove id
        remId: function(name) {
            ids[name] = undefined;
        }
    };
    workingContext.push(Component);

    doc = new QMLItem(meta, parent, engine);
    item = doc.$children[0];

    workingContext.pop();

    function heightGetter() {
        return item.height; 
    }
    setupGetter(doc, "height", heightGetter);

    function widthGetter() {
        return item.width;
    }
    setupGetter(doc, "width", widthGetter);


    doc.$draw = function(c) {
        c.save();
        c.fillStyle = "pink";
        c.fillRect(0, 0, c.canvas.width, c.canvas.height);
        c.restore();
        item.$draw(c);
    }
    doc.$init = function() {
        if (engine.renderMode == QMLRenderMode.DOM) {
            engine.rootElement.innerHTML = "";
            engine.rootElement.appendChild(doc.$domElement);
        }
        workingContext.push(Component);
        // The init-methods are called in reverse order for the $init
        // from QMLBaseObject, where explicitly-set-properties are applied,
        // needs to be called last.
        for (var i = item.$init.length - 1; i>=0; i--)
            item.$init[i]();
        workingContext.pop();

        if (engine.renderMode == QMLRenderMode.DOM) {
            doc.$domElement.style.position = "relative";
            doc.$domElement.style.top = "0";
            doc.$domElement.style.left = "0";
            doc.$domElement.style.overflow = "hidden";
            doc.$domElement.style.width = item.width + "px";
            doc.$domElement.style.height = item.height + "px";
        }
    }
    // todo: legacy. remove
    doc.draw = doc.$draw;
    doc.getHeight = function() { return doc.height };
    doc.getWidth = function() { return doc.width };

    return doc; // todo: return doc instead of item

}

function QMLTimer(meta, parent, engine) {
    QMLBaseObject.call(this, meta, parent, engine);
    var prevTrigger,
        self = this;

    createSimpleProperty(this, "interval");
    createSimpleProperty(this, "repeat");
    createSimpleProperty(this, "running");
    createSimpleProperty(this, "triggeredOnStart");

    this.$init.push(function() {
        self.interval = 1000;
        self.repeat = false;
        self.running = false;
        self.triggeredOnStart = false;
    });

    // Create trigger as simple property. Reading the property triggers
    // the function!
    createFunction(this, "onTriggered");

    engine.$addTicker(ticker);
    function ticker(now, elapsed) {
        if (self.running) {
            if (now - prevTrigger >= self.interval) {
                prevTrigger = now;
                trigger();
            }
        }
    }

    this.start = function() {
        if (!this.running) {
            this.running = true;
            prevTrigger = (new Date).getTime();
            if (this.triggeredOnStart) {
                trigger();
            }
        }
    }
    this.stop = function() {
        if (this.running) {
            this.running = false;
        }
    }
    this.restart = function() {
        this.stop();
        this.start();
    }

    function trigger() {
        // Trigger this.
        self.onTriggered();

        engine.$requestDraw();
    }

    engine.$registerStart(function() {
        if (self.running) {
            self.running = false; // toggled back by self.start();
            self.start();
        }
    });

    engine.$registerStop(function() {
        self.stop();
    });
}

function QMLAnimation(meta, parent, engine) {
    QMLBaseObject.call(this, meta, parent, engine);
    var self = this;

    // Exports
    this.Animation = {
        Infinite: -1
    };

    createSimpleProperty(this, "alwaysRunToEnd");
    createSimpleProperty(this, "loops");
    createSimpleProperty(this, "paused");
    createSimpleProperty(this, "running");

    this.$init.push(function() {
        self.alwaysRunToEnd = false;
        self.loops = 1;
        self.paused = false;
        self.running = false;
    });

    // Methods
    this.restart = function() {
        this.stop();
        this.start();
    };
    // To be overridden
    this.complete = unboundMethod;
    this.pause = unboundMethod;
    this.resume = unboundMethod;
    this.start = unboundMethod;
    this.stop = unboundMethod;
}

function QMLSequentialAnimation(meta, parent, engine) {
    QMLAnimation.call(this, meta, parent, engine);
    var curIndex,
        passedLoops,
        i,
        self = this;

    function nextAnimation(proceed) {

        var anim;
        if (self.running && !proceed) {
            curIndex++;
            if (curIndex < self.$children.length) {
                anim = self.$children[curIndex];
                console.log("nextAnimation", self, curIndex, anim);
                descr("", anim, ["target"]);
                anim.from = anim.target[anim.property];
                anim.start();
            } else {
                passedLoops++;
                if (passedLoops >= self.loops) {
                    self.complete();
                } else {
                    curIndex = -1;
                    nextAnimation();
                }
            }
        }
    }

    for (i = 0; i < this.$children.length; i++) {
        this.$children[i].$onRunningChanged.push(nextAnimation);
    }
    // $children is already constructed,


    this.start = function() {
        if (!this.running) {
            this.running = true;
            curIndex = -1;
            passedLoops = 0;
            nextAnimation();
        }
    }
    this.stop = function() {
        if (this.running) {
            this.running = false;
            if (curIndex < this.$children.length) {
                this.$children[curIndex].stop();
            }
        }
    }

    this.complete = function() {
        if (this.running) {
            if (curIndex < this.$children.length) {
                // Stop current animation
                this.$children[curIndex].stop();
            }
            this.running = false;
        }
    }

    engine.$registerStart(function() {
        if (self.running) {
            self.running = false; // toggled back by start();
            self.start();
        }
    });
    engine.$registerStop(function() {
        self.stop();
    });
};

function QMLPropertyAnimation(meta, parent, engine) {
    QMLAnimation.call(this, meta, parent, engine);
    var self = this;

    // Exports
    this.Easing = {
        Linear: 1,
        InOutCubic: 2
        // TODO: rest and support for them.
    };

    createSimpleProperty(this, "duration");
    this.easing = {};
    createSimpleProperty(this.easing, "type", { altParent: this });
    createSimpleProperty(this.easing, "amplitude", { altParent: this });
    createSimpleProperty(this.easing, "overshoot", { altParent: this });
    createSimpleProperty(this.easing, "period", { altParent: this });
    createSimpleProperty(this, "from");
    createSimpleProperty(this, "properties");
    createSimpleProperty(this, "property");
    createSimpleProperty(this, "target");
    createSimpleProperty(this, "targets");
    createSimpleProperty(this, "to");

    this.$init.push(function() {
        self.duration = 250;
        self.easing.type = self.Easing.Linear;
        self.from = 0;
        self.properties = [];
        self.targets = [];
        self.to = 0;
    });
}

function QMLNumberAnimation(meta, parent, engine) {
    QMLPropertyAnimation.call(this, meta, parent, engine);
    var tickStart,
        self = this;

    engine.$addTicker(ticker);

    function curve(place) {
        switch(self.easing.type) {

         case self.Easing.InOutCubic:
            // todo: better estimate
            return 0.5 + Math.sin(place*Math.PI - Math.PI / 2) / 2
         default:
            console.log("Unsupported animation type: ", self.easing.type);
         case self.Easing.Linear:
            return place;
        }
    }

    function ticker(now, elapsed) {
        if (self.running) {
            if (now > tickStart + self.duration) {
                self.complete();
            } else {
                var at = (now - tickStart) / self.duration,
                    value = curve(at) * (self.to - self.from) + self.from;
                self.target[self.property] = new QMLTransientValue(value);
                engine.$requestDraw();
            }

        }
    }

    // Methods
    this.start = function() {
        if (!this.running) {
            this.running = true;
            tickStart = (new Date).getTime();
        }
    }

    this.stop = function() {
        if (this.running) {
            this.running = false;
        }
    }

    this.complete = function() {
        if (this.running) {
            this.target[this.property] = this.to;
            this.stop();
            engine.$requestDraw();
        }
    }
}

})();
