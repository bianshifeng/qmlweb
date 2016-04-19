registerQmlType({
  module:   'QtQuick.Controls',
  name:     'CheckBox',
  versions: /.*/,
  baseClass: QMLItem,
  constructor: function QMLCheckbox(meta) {
    this.dom = document.createElement("label");
    QMLItem.call(this, meta);
    var self = this;

    var QMLFont = new getConstructor('QtQuick', '2.0', 'Font');
    this.font = new QMLFont(this);

    this.dom.innerHTML = "<input type=\"checkbox\"><span></span>";
    this.dom.style.pointerEvents = "auto";
    this.dom.firstChild.style.verticalAlign = "text-bottom";

    createSimpleProperty("string", this, "text");
    createSimpleProperty("bool", this, "checked");
    createSimpleProperty("color", this, "color");

    this.Component.completed.connect(this, function() {
        this.implicitHeight = this.dom.offsetHeight;
        this.implicitWidth = this.dom.offsetWidth > 0 ? this.dom.offsetWidth + 4 : 0;
    });
    this.textChanged.connect(this, function(newVal) {
        this.dom.children[1].innerHTML = newVal;
        this.implicitHeight = this.dom.offsetHeight;
        this.implicitWidth = this.dom.offsetWidth > 0 ? this.dom.offsetWidth + 4 : 0;
    });
    this.colorChanged.connect(this, function(newVal) {
        this.dom.children[1].style.color = QMLColor(newVal);
    });

    this.checkedChanged.connect(this, function(newVal) {
        this.dom.firstChild.checked = self.checked;
    });

    this.dom.firstChild.onchange = function() {
        self.checked = this.checked;
    };
  }
});
