import {
  SelectPageObjectType,
  SelectPageObject,
  Selector,
  ClickablePageObjectType,
  ClickablePageObject,
} from 'e2e-test/core/pageObjects';
import { TestPage } from 'e2e-test/core/pages';

export interface EditPanelPage {
  queriesTab: ClickablePageObjectType;
  saveDashboard: ClickablePageObjectType;
  scenarioSelect: SelectPageObjectType;
  showXAxis: ClickablePageObjectType;
  visualizationTab: ClickablePageObjectType;
}

export const editPanelPage = new TestPage<EditPanelPage>({
  pageObjects: {
    queriesTab: new ClickablePageObject(Selector.fromAriaLabel('Queries tab button')),
    saveDashboard: new ClickablePageObject(Selector.fromAriaLabel('Save dashboard navbar button')),
    scenarioSelect: new SelectPageObject(Selector.fromAriaLabel('Scenario Select')),
    showXAxis: new ClickablePageObject(Selector.fromSelector('[aria-label="X-Axis section"] > gf-form-switch')),
    visualizationTab: new ClickablePageObject(Selector.fromAriaLabel('Visualization tab button')),
  },
});
